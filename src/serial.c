#include <errno.h>
#include <string.h>

#include <dt-bindings/zmk/bt.h>
#include <zephyr/device.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/printk.h>
#include <zmk/ble.h>
#include <zmk/events/usb_conn_state_changed.h>
#include <zmk/keymap.h>
#include <zmk/physical_layouts.h>

#include "encoder.h"
#include "keymap.h"
#include "macro.h"
#include "runtime.h"

LOG_MODULE_DECLARE(zdkm);

#define LEGACY_ARM_MS 20000
#define SESSION_TOKEN_LENGTH 32
#define LAYER_NAME_BYTES MIN(CONFIG_ZMK_KEYMAP_LAYER_NAME_MAX_LEN - 1, 73)

BUILD_ASSERT(DT_HAS_CHOSEN(zdkm_uart), "zdkm: enable the zdkm-usb snippet");
static const struct device *const uart = DEVICE_DT_GET(DT_CHOSEN(zdkm_uart));

struct command {
    char line[224 + sizeof("WRITE ") - 1 + SESSION_TOKEN_LENGTH + 1];
};

K_MSGQ_DEFINE(commands, sizeof(struct command), 2, 1);
static struct command receiving;
static size_t received;
static bool discarded;
static struct k_spinlock auth_lock;
static int64_t legacy_auth_deadline;
static bool authorized;
/* Bind repeated writes to their initiating client even if a brief DTR drop is missed. */
static char auth_token[SESSION_TOKEN_LENGTH + 1];

static bool port_open(void) {
    uint32_t dtr = 0;
    return uart_line_ctrl_get(uart, UART_LINE_CTRL_DTR, &dtr) == 0 && dtr;
}

static void clear_auth(void) {
    k_spinlock_key_t key = k_spin_lock(&auth_lock);
    legacy_auth_deadline = 0;
    authorized = false;
    auth_token[0] = '\0';
    k_spin_unlock(&auth_lock, key);
}

void zdkm_authorize(void) {
    int64_t now = k_uptime_get();
    if (!port_open()) {
        clear_auth();
        return;
    }
    k_spinlock_key_t key = k_spin_lock(&auth_lock);
    if (auth_token[0] || now < legacy_auth_deadline) {
        authorized = true;
    }
    k_spin_unlock(&auth_lock, key);
}

static bool auth_state(bool consume, const char *token) {
    if (!port_open()) {
        clear_auth();
        return false;
    }
    int64_t now = k_uptime_get();
    k_spinlock_key_t key = k_spin_lock(&auth_lock);
    bool allowed = authorized && (token ? strcmp(auth_token, token) == 0
                                        : !auth_token[0] && now < legacy_auth_deadline);
    if (consume && allowed && !token) {
        legacy_auth_deadline = 0;
        authorized = false;
    }
    k_spin_unlock(&auth_lock, key);
    return allowed;
}

static bool auth_needs_port_check(void) {
    int64_t now = k_uptime_get();
    k_spinlock_key_t key = k_spin_lock(&auth_lock);
    bool armed = auth_token[0] || now < legacy_auth_deadline;
    k_spin_unlock(&auth_lock, key);
    return armed;
}

static bool arm_auth(const char *token) {
    int64_t deadline = token ? 0 : k_uptime_get() + LEGACY_ARM_MS;
    k_spinlock_key_t key = k_spin_lock(&auth_lock);
    bool unlocked = token && authorized && strcmp(auth_token, token) == 0;
    if (!unlocked) {
        legacy_auth_deadline = deadline;
        authorized = false;
        if (token) memcpy(auth_token, token, sizeof(auth_token));
        else auth_token[0] = '\0';
    }
    k_spin_unlock(&auth_lock, key);
    return unlocked;
}

static int usb_state_listener(const zmk_event_t *event) {
    const struct zmk_usb_conn_state_changed *state = as_zmk_usb_conn_state_changed(event);
    if (state && state->conn_state == ZMK_USB_CONN_NONE) {
        clear_auth();
    }
    return ZMK_EV_EVENT_BUBBLE;
}

ZMK_LISTENER(zdkm_usb, usb_state_listener);
ZMK_SUBSCRIPTION(zdkm_usb, zmk_usb_conn_state_changed);

static void rx_byte(uint8_t byte) {
    if (byte == '\n') {
        if (discarded) {
            receiving.line[0] = '\0';
            k_msgq_put(&commands, &receiving, K_NO_WAIT);
        } else if (received) {
            if (receiving.line[received - 1] == '\r') {
                --received;
            }
            receiving.line[received] = '\0';
            if (received) {
                k_msgq_put(&commands, &receiving, K_NO_WAIT);
            }
        }
        received = 0;
        discarded = false;
    } else if (!discarded) {
        if ((byte != '\r' && (byte < ' ' || byte > '~')) ||
            received == sizeof(receiving.line) - 1) {
            discarded = true;
        } else {
            receiving.line[received++] = byte;
        }
    }
}

static void uart_callback(const struct device *device, void *context) {
    ARG_UNUSED(context);
    if (!uart_irq_update(device) || !uart_irq_rx_ready(device)) {
        return;
    }
    uint8_t bytes[16];
    int count;
    do {
        count = uart_fifo_read(device, bytes, sizeof(bytes));
        for (int i = 0; i < count; ++i) {
            rx_byte(bytes[i]);
        }
    } while (count == sizeof(bytes));
}

static void send_line(const char *line) {
    if (!port_open()) {
        return;
    }
    while (*line) {
        uart_poll_out(uart, *line++);
    }
    uart_poll_out(uart, '\n');
}

static char *take_word(char **cursor) {
    while (**cursor == ' ') {
        ++*cursor;
    }
    if (!**cursor) {
        return NULL;
    }
    char *word = *cursor;
    while (**cursor && **cursor != ' ') {
        ++*cursor;
    }
    if (**cursor) {
        *(*cursor)++ = '\0';
    }
    return word;
}

static const char *take_session_token(char **cursor) {
    const char *token = take_word(cursor);
    if (!token || strlen(token) != SESSION_TOKEN_LENGTH) return NULL;
    for (size_t i = 0; i < SESSION_TOKEN_LENGTH; ++i) {
        char c = token[i];
        if ((c < '0' || c > '9') && (c < 'a' || c > 'f')) return NULL;
    }
    return token;
}

static bool take_uint(char **cursor, uint32_t limit, uint32_t *result) {
    const char *word = take_word(cursor);
    if (!word) {
        return false;
    }
    uint32_t value = 0;
    while (*word) {
        if (*word < '0' || *word > '9') {
            return false;
        }
        uint32_t digit = *word++ - '0';
        if (value > limit / 10 || (value == limit / 10 && digit > limit % 10)) return false;
        value = value * 10 + digit;
    }
    *result = value;
    return true;
}

static bool take_number(char **cursor, uint16_t limit, uint16_t *result) {
    uint32_t value;
    if (!take_uint(cursor, limit, &value)) return false;
    *result = value;
    return true;
}

static bool read_positions(char **cursor, struct zdkm_combo *combo) {
    while (**cursor) {
        while (**cursor == ' ') ++*cursor;
        if (!**cursor) break;
        uint16_t position;
        if (!take_number(cursor, zdkm_position_count() - 1, &position) ||
            !zdkm_add_position(combo, position)) return false;
    }
    return combo->count >= 2;
}

static const char *status_name(enum zdkm_status status) {
    switch (status) {
    case ZDKM_ACTIVE:
        return "active";
    case ZDKM_PENDING:
        return "pending";
    case ZDKM_INVALID:
        return "invalid";
    default:
        return "loading";
    }
}

static void send_save_result(int slot, struct zdkm_combo combo, const char *token) {
    if (!auth_state(true, token)) {
        send_line("ERR LOCKED");
        return;
    }
    int err = zdkm_save(slot, combo);
    switch (err) {
    case 0:
        send_line("OK SAVED");
        return;
    case -EINVAL:
        send_line("ERR INVALID");
        return;
    case -ENOTSUP:
        send_line("ERR KEY_USAGE");
        return;
    case -EEXIST:
        send_line("ERR DUPLICATE");
        return;
    case -EBUSY:
        send_line("ERR BUSY");
        return;
    case -EBADMSG:
        send_line("ERR RESET_REQUIRED");
        return;
    case -ENOSPC:
        send_line("ERR NO_SPACE");
        return;
    default: {
        char response[32];
        snprintk(response, sizeof(response), "ERR STORAGE %d", err);
        send_line(response);
    }
    }
}

static void send_edit_result(int err) {
    char response[32];
    switch (err) {
    case 0: send_line("OK SAVED"); return;
    case -EINVAL: send_line("ERR INVALID"); return;
    case -ENOTSUP: send_line("ERR KEY_USAGE"); return;
    case -EPERM: send_line("ERR LAST_UNLOCK"); return;
    case -EAGAIN: send_line("ERR KEYS_HELD"); return;
    case -EBUSY: send_line("ERR EDIT_BUSY"); return;
    case -EFAULT: send_line("ERR RESTART"); return;
    default:
        snprintk(response, sizeof(response), "ERR STORAGE %d", err);
        send_line(response);
    }
}

static void send_check_result(int err) {
    if (err == 0) send_line("OK VALID");
    else send_edit_result(err);
}

static const char *line_label(const char *label, const char *fallback) {
    return !label || !*label || strlen(label) > 100 || strchr(label, '\r') || strchr(label, '\n')
               ? fallback
               : label;
}

static uint8_t param_kind(size_t count, const struct behavior_parameter_value_metadata *values) {
    if (!count) return 0;
    for (size_t i = 1; i < count; ++i) {
        if (values[i].type != values[0].type) return 1;
    }
    switch (values[0].type) {
    case BEHAVIOR_PARAMETER_VALUE_TYPE_NIL: return 0;
    case BEHAVIOR_PARAMETER_VALUE_TYPE_HID_USAGE: return 2;
    case BEHAVIOR_PARAMETER_VALUE_TYPE_LAYER_ID: return 3;
    default: return 1;
    }
}

static bool bluetooth_behavior(const char *name) {
#if IS_ENABLED(CONFIG_ZMK_BLE) && DT_NODE_HAS_STATUS(DT_NODELABEL(bt), okay)
    return name && strcmp(name, DEVICE_DT_NAME(DT_NODELABEL(bt))) == 0;
#else
    ARG_UNUSED(name);
    return false;
#endif
}

static unsigned int bluetooth_profile_count(void) {
#if IS_ENABLED(CONFIG_ZMK_BLE)
    return ZMK_BLE_PROFILE_COUNT;
#else
    return 0;
#endif
}

static bool bluetooth_profile_command(uint32_t command) {
    return command == BT_SEL_CMD || command == BT_DISC_CMD;
}

static void behavior_operation(char *response, size_t size, const struct zmk_behavior_ref *ref,
                               uint16_t index) {
    bool bluetooth = bluetooth_behavior(ref->device->name);
    bool supported = bluetooth;
#if DT_NODE_HAS_STATUS(DT_NODELABEL(out), okay)
    supported |= strcmp(ref->device->name, DEVICE_DT_NAME(DT_NODELABEL(out))) == 0;
#endif
    struct behavior_parameter_metadata info;
    if (supported && behavior_get_parameter_metadata(ref->device, &info) >= 0) {
        for (size_t i = 0; i < info.sets_len; ++i) {
            const struct behavior_parameter_metadata_set *set = &info.sets[i];
            for (size_t j = 0; j < set->param1_values_len; ++j) {
                const struct behavior_parameter_value_metadata *entry = &set->param1_values[j];
                const char *label = line_label(entry->display_name, NULL);
                if (entry->type != BEHAVIOR_PARAMETER_VALUE_TYPE_VALUE || !label) continue;
                bool needs_profile = bluetooth && bluetooth_profile_command(entry->value);
                unsigned int profiles = needs_profile ? bluetooth_profile_count() : 0;
                if (needs_profile && !profiles) continue;
                if (index-- != 0) continue;
                snprintk(response, size, "OK BEHAVIOROPS %u %u %s",
                         (unsigned int)entry->value, profiles, label);
                return;
            }
        }
    }
    snprintk(response, size, "OK BEHAVIOROPS END");
}

static bool valid_layer_name(const uint8_t *name, size_t len) {
    if (!len || name[0] == ' ' || name[len - 1] == ' ') return false;
    for (size_t i = 0; i < len;) {
        uint8_t lead = name[i++];
        if (lead >= ' ' && lead < 0x7f) continue;
        if (lead < 0xc2 || lead > 0xf4) return false;
        size_t trailing = lead < 0xe0 ? 1 : lead < 0xf0 ? 2 : 3;
        if (len - i < trailing) return false;
        uint8_t first = name[i];
        if ((lead == 0xe0 && first < 0xa0) || (lead == 0xed && first >= 0xa0) ||
            (lead == 0xf0 && first < 0x90) || (lead == 0xf4 && first >= 0x90)) return false;
        while (trailing--) {
            if ((name[i++] & 0xc0) != 0x80) return false;
        }
    }
    return true;
}

static bool process_editor_command(const char *operation, char *cursor, const char *token) {
    char response[224];
    uint16_t index;
    if (strcmp(operation, "BACKUPID") == 0) {
        if (take_word(&cursor)) goto invalid;
        snprintk(response, sizeof(response), "OK BACKUPID %u %u",
                 (unsigned int)zdkm_backup_layout_id(), (unsigned int)zdkm_backup_behavior_id());
    } else if (strcmp(operation, "FEATURES") == 0) {
        if (take_word(&cursor)) goto invalid;
        snprintk(response, sizeof(response), "OK FEATURES %u %u %u %u %u",
                 (unsigned int)zdkm_behavior_count(), ZDKM_MACRO_SLOTS, ZDKM_MACRO_STEPS,
                 zmk_behavior_get_local_id(DEVICE_DT_NAME(DT_NODELABEL(kp))),
                 zmk_behavior_get_local_id(DEVICE_DT_NAME(DT_NODELABEL(zdkm_macro))));
    } else if (strcmp(operation, "ENCODERS") == 0) {
        if (take_word(&cursor)) goto invalid;
        snprintk(response, sizeof(response), "OK ENCODERS %u", zdkm_encoder_count());
    } else if (strcmp(operation, "ENCODER") == 0 || strcmp(operation, "ENCODERSET") == 0 ||
               strcmp(operation, "ENCODERCHECK") == 0) {
        uint16_t sensor;
        struct zdkm_encoder_codes codes;
        if (!zdkm_encoder_count() || !take_number(&cursor, zdkm_layer_count() - 1, &index) ||
            !take_number(&cursor, zdkm_encoder_count() - 1, &sensor)) goto invalid;
        if (strcmp(operation, "ENCODER") != 0) {
            if (!take_uint(&cursor, UINT32_MAX, &codes.clockwise) ||
                !take_uint(&cursor, UINT32_MAX, &codes.counterclockwise) || take_word(&cursor)) goto invalid;
            if (strcmp(operation, "ENCODERCHECK") == 0) {
                send_check_result(zdkm_encoder_check(index, sensor, &codes));
                return true;
            }
            if (!auth_state(true, token)) {
                send_line("ERR LOCKED");
                return true;
            }
            send_edit_result(zdkm_encoder_save(index, sensor, &codes));
            return true;
        }
        if (take_word(&cursor)) goto invalid;
        if (zdkm_encoder_get(index, sensor, &codes) < 0) {
            send_line("OK ENCODER 0 0");
            return true;
        }
        snprintk(response, sizeof(response), "OK ENCODER %u %u", (unsigned int)codes.clockwise,
                 (unsigned int)codes.counterclockwise);
    } else if (strcmp(operation, "LAYEREDIT") == 0) {
        if (take_word(&cursor)) goto invalid;
        snprintk(response, sizeof(response), "OK LAYEREDIT %u", LAYER_NAME_BYTES);
    } else if (strcmp(operation, "LAYERSET") == 0 || strcmp(operation, "LAYERCHECK") == 0) {
        if (!take_number(&cursor, zdkm_layer_count() - 1, &index)) goto invalid;
        const char *hex = take_word(&cursor);
        uint8_t name[LAYER_NAME_BYTES + 1];
        if (!hex || take_word(&cursor)) goto invalid;
        size_t len = 0;
        if (strcmp(hex, "-") != 0) {
            size_t size = strlen(hex);
            if ((size & 1) || size > 2 * LAYER_NAME_BYTES) goto invalid;
            len = hex2bin(hex, size, name, LAYER_NAME_BYTES);
            if (len != size / 2 || !valid_layer_name(name, len)) goto invalid;
        }
        name[len] = 0;
        if (strcmp(operation, "LAYERCHECK") == 0) {
            send_check_result(zdkm_check_layer_name(index, (const char *)name));
            return true;
        }
        if (!auth_state(true, token)) {
            send_line("ERR LOCKED");
            return true;
        }
        send_edit_result(zdkm_rename_layer(index, (const char *)name));
        return true;
    } else if (strcmp(operation, "LAYER") == 0) {
        if (!take_number(&cursor, zdkm_layer_count() - 1, &index) || take_word(&cursor)) goto invalid;
        uint8_t layer = zmk_keymap_layer_index_to_id(index);
        const char *name = layer == ZMK_KEYMAP_LAYER_ID_INVAL ? NULL : zmk_keymap_layer_name(layer);
        snprintk(response, sizeof(response), "OK LAYER %u %s", layer, line_label(name, ""));
    } else if (strcmp(operation, "BEHAVIOR") == 0) {
        if (!take_number(&cursor, UINT16_MAX, &index) || take_word(&cursor)) goto invalid;
        const struct zmk_behavior_ref *ref = zdkm_behavior_at(index);
        if (!ref) goto invalid;
        struct behavior_parameter_metadata info;
        int err = behavior_get_parameter_metadata(ref->device, &info);
        uint8_t first = 0, second = 0;
        if (err >= 0) {
            for (size_t i = 0; i < info.sets_len; ++i) {
                const struct behavior_parameter_metadata_set *set = &info.sets[i];
                uint8_t p1 = param_kind(set->param1_values_len, set->param1_values);
                uint8_t p2 = param_kind(set->param2_values_len, set->param2_values);
                first = (first && p1 && first != p1) ? 1 : MAX(first, p1);
                second = (second && p2 && second != p2) ? 1 : MAX(second, p2);
            }
        }
        snprintk(response, sizeof(response), "OK BEHAVIOR %u %u %u %u %s",
                 zmk_behavior_get_local_id(ref->device->name), first, second, err >= 0,
                 line_label(ref->metadata.display_name, ref->device->name));
    } else if (strcmp(operation, "BEHAVIOROPS") == 0) {
        uint16_t entry;
        if (!take_number(&cursor, UINT16_MAX, &index) ||
            !take_number(&cursor, UINT16_MAX, &entry) || take_word(&cursor)) goto invalid;
        const struct zmk_behavior_ref *ref = zdkm_behavior_at(index);
        if (!ref) goto invalid;
        behavior_operation(response, sizeof(response), ref, entry);
    } else if (strcmp(operation, "BIND") == 0 || strcmp(operation, "BINDSET") == 0 ||
               strcmp(operation, "BINDCHECK") == 0) {
        uint16_t position;
        if (!take_number(&cursor, zdkm_layer_count() - 1, &index) ||
            !take_number(&cursor, MIN(zdkm_position_count() - 1, UINT8_MAX), &position)) goto invalid;
        if (strcmp(operation, "BIND") != 0) {
            uint16_t id;
            struct zmk_behavior_binding binding = {0};
            if (!take_number(&cursor, UINT16_MAX, &id) ||
                !take_uint(&cursor, UINT32_MAX, &binding.param1) ||
                !take_uint(&cursor, UINT32_MAX, &binding.param2) || take_word(&cursor)) goto invalid;
            if (id != UINT16_MAX) {
                binding.behavior_dev = zmk_behavior_find_behavior_name_from_local_id(id);
                if (!binding.behavior_dev) goto invalid;
            }
            if (bluetooth_behavior(binding.behavior_dev) && bluetooth_profile_command(binding.param1) &&
                binding.param2 >= bluetooth_profile_count()) goto invalid;
#if IS_ENABLED(CONFIG_ZMK_BEHAVIOR_LOCAL_IDS_IN_BINDINGS)
            binding.local_id = id;
#endif
            if (strcmp(operation, "BINDCHECK") == 0) {
                send_check_result(zdkm_check_binding(index, position, &binding));
                return true;
            }
            if (!auth_state(true, token)) {
                send_line("ERR LOCKED");
                return true;
            }
            send_edit_result(zdkm_set_binding(index, position, &binding));
            return true;
        }
        if (take_word(&cursor)) goto invalid;
        const struct zmk_behavior_binding *binding = zmk_keymap_get_layer_binding_at_idx(index, position);
        snprintk(response, sizeof(response), "OK BIND %u %u %u",
                 binding ? zmk_behavior_get_local_id(binding->behavior_dev) : UINT16_MAX,
                 binding ? (unsigned int)binding->param1 : 0, binding ? (unsigned int)binding->param2 : 0);
    } else if (strcmp(operation, "MACRO") == 0 || strcmp(operation, "MACROSET") == 0) {
        struct zdkm_macro macro = {0};
        if (!take_number(&cursor, ZDKM_MACRO_SLOTS - 1, &index)) goto invalid;
        if (strcmp(operation, "MACROSET") == 0) {
            uint16_t count;
            if (!take_number(&cursor, ZDKM_MACRO_STEPS, &count)) goto invalid;
            macro.count = count;
            for (size_t i = 0; i < count; ++i) {
                if (!take_uint(&cursor, UINT32_MAX, &macro.steps[i])) goto invalid;
            }
            if (take_word(&cursor)) goto invalid;
            if (!auth_state(true, token)) {
                send_line("ERR LOCKED");
                return true;
            }
            send_edit_result(zdkm_macro_save(index, &macro));
            return true;
        }
        if (take_word(&cursor)) goto invalid;
        if (zdkm_macro_get(index, &macro) < 0) {
            send_line("OK MACRO INVALID");
            return true;
        }
        size_t used = snprintk(response, sizeof(response), "OK MACRO %u", macro.count);
        for (size_t i = 0; i < macro.count; ++i) {
            used += snprintk(response + used, sizeof(response) - used, " %u", (unsigned int)macro.steps[i]);
        }
    } else {
        return false;
    }
    send_line(response);
    return true;

invalid:
    send_line("ERR INVALID");
    return true;
}

static void process_command(char *cursor) {
    const char *operation = take_word(&cursor);
    const char *token = NULL;
    char response[224];
    uint16_t index;

    if (!operation) {
        send_line("ERR FRAME");
        return;
    }
    if (strcmp(operation, "ARMSESSION") == 0 || strcmp(operation, "SESSIONAUTH") == 0) {
        token = take_session_token(&cursor);
        if (!token || take_word(&cursor)) {
            send_line("ERR INVALID");
        } else if (strcmp(operation, "ARMSESSION") == 0) {
            send_line(arm_auth(token) ? "OK UNLOCKED" : "OK ARMED");
        } else {
            send_line(auth_state(false, token) ? "OK UNLOCKED" : "OK LOCKED");
        }
        return;
    }
    if (strcmp(operation, "WRITE") == 0) {
        token = take_session_token(&cursor);
        operation = take_word(&cursor);
        if (!token || !operation) {
            send_line("ERR INVALID");
            return;
        }
        if (!auth_state(false, token)) {
            send_line("ERR LOCKED");
            return;
        }
    }
    if (process_editor_command(operation, cursor, token)) return;
    if (strcmp(operation, "SET") == 0) {
        uint16_t first, second, usage;
        if (!take_number(&cursor, zdkm_slot_count() - 1, &index) ||
            !take_number(&cursor, zdkm_position_count() - 1, &first) ||
            !take_number(&cursor, zdkm_position_count() - 1, &second) ||
            !take_number(&cursor, UINT8_MAX, &usage) || !usage || first == second ||
            take_word(&cursor)) {
            send_line("ERR INVALID");
            return;
        }
        struct zdkm_combo previous = zdkm_get_combo(index);
        if (!zdkm_is_legacy(&previous)) {
            send_line("ERR UPGRADE");
            return;
        }
        send_save_result(index, (struct zdkm_combo){
            .positions = {MIN(first, second), MAX(first, second)},
            .count = 2,
            .output = usage,
            .timeout_ms = CONFIG_ZDKM_COMBO_TIMEOUT_MS,
        }, token);
        return;
    }
    if (strcmp(operation, "PUT") == 0) {
        uint16_t slow;
        struct zdkm_combo combo = {0};
        if (!take_number(&cursor, zdkm_slot_count() - 1, &index) ||
            !take_uint(&cursor, UINT32_MAX, &combo.output) ||
            !take_number(&cursor, UINT16_MAX, &combo.timeout_ms) ||
            !take_number(&cursor, UINT16_MAX, &combo.prior_idle_ms) ||
            !take_uint(&cursor, UINT32_MAX, &combo.layers) ||
            !take_number(&cursor, 1, &slow) || !read_positions(&cursor, &combo)) {
            send_line("ERR INVALID");
            return;
        }
        combo.slow_release = slow;
        send_save_result(index, combo, token);
        return;
    }
    if (strcmp(operation, "SLOT") == 0 || strcmp(operation, "COMBO") == 0 ||
        strcmp(operation, "DEL") == 0) {
        if (!take_number(&cursor, zdkm_slot_count() - 1, &index) || take_word(&cursor)) {
            send_line("ERR INVALID");
            return;
        }
        if (strcmp(operation, "DEL") == 0) {
            send_save_result(index, (struct zdkm_combo){0}, token);
        } else {
            struct zdkm_combo combo = zdkm_get_combo(index);
            if (strcmp(operation, "SLOT") == 0) {
                if (!zdkm_is_legacy(&combo)) {
                    send_line("ERR UPGRADE");
                    return;
                }
                snprintk(response, sizeof(response), "OK SLOT %u %u %u",
                         (unsigned int)combo.positions[0], (unsigned int)combo.positions[1],
                         (unsigned int)combo.output);
            } else {
                size_t used = snprintk(response, sizeof(response), "OK COMBO %u %u %u %u %u %u",
                    (unsigned int)combo.output, (unsigned int)combo.timeout_ms,
                    (unsigned int)combo.prior_idle_ms, (unsigned int)combo.layers,
                    (unsigned int)combo.slow_release, (unsigned int)combo.count);
                for (size_t i = 0; i < combo.count; ++i) {
                    used += snprintk(response + used, sizeof(response) - used, " %u",
                                    (unsigned int)combo.positions[i]);
                }
            }
            send_line(response);
        }
        return;
    }
    if (strcmp(operation, "ACTION") == 0) {
        uint16_t code;
        const char *name = NULL;
        if (take_number(&cursor, UINT16_MAX, &index) && !take_word(&cursor)) {
            name = zdkm_action_at(index, &code);
        }
        if (!name || !*name || strchr(name, '\r') || strchr(name, '\n')) {
            send_line("ERR INVALID");
            return;
        }
        snprintk(response, sizeof(response), "OK ACTION %u %s", (unsigned int)code, name);
        send_line(response);
        return;
    }
    if (strcmp(operation, "KEY") == 0) {
        if (!take_number(&cursor, zdkm_position_count() - 1, &index) || take_word(&cursor)) {
            send_line("ERR INVALID");
            return;
        }
        const struct zmk_physical_layout *const *layouts;
        zmk_physical_layouts_get_list(&layouts);
        const struct zmk_key_physical_attrs *key = &layouts[0]->keys[index];
        snprintk(response, sizeof(response), "OK KEY %d %d %d %d %d %d %d", key->x, key->y,
                 key->width, key->height,
#if IS_ENABLED(CONFIG_ZMK_PHYSICAL_LAYOUT_KEY_ROTATION)
                 key->r, key->rx, key->ry
#else
                 0, 0, 0
#endif
        );
        send_line(response);
        return;
    }
    if (take_word(&cursor)) {
        send_line("ERR INVALID");
    } else if (strcmp(operation, "HELLO") == 0) {
        clear_auth();
        send_line("OK ZDKM 1");
    } else if (strcmp(operation, "SESSION") == 0) {
        send_line("OK SESSION");
    } else if (strcmp(operation, "SESSIONWAIT") == 0) {
        send_line("OK SESSIONWAIT");
    } else if (strcmp(operation, "INFO") == 0) {
        snprintk(response, sizeof(response), "OK INFO %u %u %u %s",
                 (unsigned int)zdkm_position_count(), (unsigned int)zdkm_slot_count(),
                 (unsigned int)CONFIG_ZDKM_COMBO_TIMEOUT_MS, status_name(zdkm_get_status()));
        send_line(response);
    } else if (strcmp(operation, "CAPS") == 0) {
        snprintk(response, sizeof(response), "OK CAPS %u %u %u",
                 (unsigned int)ZDKM_MAX_KEYS, (unsigned int)zdkm_layer_count(),
                 (unsigned int)zdkm_action_count());
        send_line(response);
    } else if (strcmp(operation, "EXTKEYS") == 0) {
        send_line(zdkm_supports_extended_keys() ? "OK EXTKEYS 1" : "OK EXTKEYS 0");
    } else if (strcmp(operation, "KEYRANGES") == 0) {
        snprintk(response, sizeof(response), "OK KEYRANGES %u %u",
                 zdkm_keyboard_usage_limit(), zdkm_consumer_usage_limit());
        send_line(response);
    } else if (strcmp(operation, "BTACTIONS") == 0) {
        snprintk(response, sizeof(response), "OK BTACTIONS %u %u",
                 zdkm_bluetooth_profiles(), zdkm_output_commands());
        send_line(response);
    } else if (strcmp(operation, "ARM") == 0) {
        arm_auth(NULL);
        send_line("OK ARMED");
    } else if (strcmp(operation, "AUTH") == 0) {
        send_line(auth_state(false, NULL) ? "OK UNLOCKED" : "OK LOCKED");
    } else if (strcmp(operation, "RESET") == 0) {
        send_save_result(-1, (struct zdkm_combo){0}, token);
    } else {
        send_line("ERR UNKNOWN");
    }
}

static void command_worker(void *arg1, void *arg2, void *arg3) {
    ARG_UNUSED(arg1);
    ARG_UNUSED(arg2);
    ARG_UNUSED(arg3);
    if (!device_is_ready(uart) || uart_irq_callback_user_data_set(uart, uart_callback, NULL) < 0) {
        LOG_ERR("Could not initialize the dynamic keymapper serial port");
        return;
    }
    uart_irq_rx_enable(uart);
    for (;;) {
        struct command command;
        k_timeout_t wait = auth_needs_port_check() ? K_MSEC(50) : K_FOREVER;
        int err = k_msgq_get(&commands, &command, wait);
        if (!port_open()) {
            clear_auth();
        } else if (err == 0) {
            process_command(command.line);
        }
    }
}

K_THREAD_DEFINE(zdkm_serial, 2048, command_worker, NULL, NULL, NULL, K_PRIO_PREEMPT(8), 0, 0);
