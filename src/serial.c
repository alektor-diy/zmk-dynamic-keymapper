#include <errno.h>
#include <string.h>

#include <zephyr/device.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/printk.h>
#include <zmk/events/usb_conn_state_changed.h>
#include <zmk/physical_layouts.h>

#include "runtime.h"

LOG_MODULE_DECLARE(zdkm);

#define ARM_MS 20000

BUILD_ASSERT(DT_HAS_CHOSEN(zdkm_uart), "zdkm: enable the zdkm-usb snippet");
static const struct device *const uart = DEVICE_DT_GET(DT_CHOSEN(zdkm_uart));

struct command {
    char line[160];
};

K_MSGQ_DEFINE(commands, sizeof(struct command), 2, 1);
static struct command receiving;
static size_t received;
static bool discarded;
static struct k_spinlock auth_lock;
static int64_t auth_deadline;
static bool authorized;

static bool port_open(void) {
    uint32_t dtr = 0;
    return uart_line_ctrl_get(uart, UART_LINE_CTRL_DTR, &dtr) == 0 && dtr;
}

static void clear_auth(void) {
    k_spinlock_key_t key = k_spin_lock(&auth_lock);
    auth_deadline = 0;
    authorized = false;
    k_spin_unlock(&auth_lock, key);
}

void zdkm_authorize(void) {
    int64_t now = k_uptime_get();
    if (!port_open()) {
        clear_auth();
        return;
    }
    k_spinlock_key_t key = k_spin_lock(&auth_lock);
    if (now < auth_deadline) {
        authorized = true;
    }
    k_spin_unlock(&auth_lock, key);
}

static bool auth_state(bool consume) {
    int64_t now = k_uptime_get();
    k_spinlock_key_t key = k_spin_lock(&auth_lock);
    bool allowed = authorized && now < auth_deadline;
    if (consume && allowed) {
        auth_deadline = 0;
        authorized = false;
    }
    k_spin_unlock(&auth_lock, key);
    return allowed;
}

static bool auth_armed(void) {
    int64_t now = k_uptime_get();
    k_spinlock_key_t key = k_spin_lock(&auth_lock);
    bool armed = now < auth_deadline;
    k_spin_unlock(&auth_lock, key);
    return armed;
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

static void send_save_result(int slot, struct zdkm_combo combo) {
    if (!auth_state(true)) {
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

static void process_command(char *cursor) {
    const char *operation = take_word(&cursor);
    char response[160];
    uint16_t index;

    if (!operation) {
        send_line("ERR FRAME");
        return;
    }
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
        });
        return;
    }
    if (strcmp(operation, "PUT") == 0) {
        uint16_t slow;
        struct zdkm_combo combo = {0};
        if (!take_number(&cursor, zdkm_slot_count() - 1, &index) ||
            !take_number(&cursor, UINT16_MAX, &combo.output) ||
            !take_number(&cursor, UINT16_MAX, &combo.timeout_ms) ||
            !take_number(&cursor, UINT16_MAX, &combo.prior_idle_ms) ||
            !take_uint(&cursor, UINT32_MAX, &combo.layers) ||
            !take_number(&cursor, 1, &slow) || !read_positions(&cursor, &combo)) {
            send_line("ERR INVALID");
            return;
        }
        combo.slow_release = slow;
        send_save_result(index, combo);
        return;
    }
    if (strcmp(operation, "SLOT") == 0 || strcmp(operation, "COMBO") == 0 ||
        strcmp(operation, "DEL") == 0) {
        if (!take_number(&cursor, zdkm_slot_count() - 1, &index) || take_word(&cursor)) {
            send_line("ERR INVALID");
            return;
        }
        if (strcmp(operation, "DEL") == 0) {
            send_save_result(index, (struct zdkm_combo){0});
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
    } else if (strcmp(operation, "ARM") == 0) {
        int64_t deadline = k_uptime_get() + ARM_MS;
        k_spinlock_key_t key = k_spin_lock(&auth_lock);
        auth_deadline = deadline;
        authorized = false;
        k_spin_unlock(&auth_lock, key);
        send_line("OK ARMED");
    } else if (strcmp(operation, "AUTH") == 0) {
        send_line(auth_state(false) ? "OK UNLOCKED" : "OK LOCKED");
    } else if (strcmp(operation, "RESET") == 0) {
        send_save_result(-1, (struct zdkm_combo){0});
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
        k_timeout_t wait = auth_armed() ? K_MSEC(50) : K_FOREVER;
        int err = k_msgq_get(&commands, &command, wait);
        if (!port_open()) {
            clear_auth();
        } else if (err == 0) {
            process_command(command.line);
        }
    }
}

K_THREAD_DEFINE(zdkm_serial, 2048, command_worker, NULL, NULL, NULL, K_PRIO_PREEMPT(8), 0, 0);
