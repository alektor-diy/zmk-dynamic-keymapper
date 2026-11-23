#include <errno.h>
#include <string.h>

#include <drivers/behavior.h>
#include <dt-bindings/zmk/hid_usage.h>
#include <dt-bindings/zmk/hid_usage_pages.h>
#include <zephyr/logging/log.h>
#include <zephyr/settings/settings.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/crc.h>
#include <zmk/events/position_state_changed.h>
#include <zmk/events/keycode_state_changed.h>
#include <zmk/hid.h>
#include <zmk/keymap.h>
#include <zmk/matrix.h>
#include <zmk/physical_layouts.h>

#include "runtime.h"
#include "macro.h"

LOG_MODULE_REGISTER(zdkm);

BUILD_ASSERT(!IS_ENABLED(CONFIG_SETTINGS_NONE), "zdkm: a persistent Settings backend is required");
BUILD_ASSERT(IS_ENABLED(CONFIG_USB_CDC_ACM), "zdkm: USB CDC ACM must be enabled");
BUILD_ASSERT(DT_NUM_INST_STATUS_OKAY(zmk_physical_layout) == 1,
             "zdkm: exactly one enabled physical layout is required");
BUILD_ASSERT(ZMK_KEYMAP_LEN <= UINT16_MAX, "zdkm: too many physical positions");
BUILD_ASSERT(ZMK_KEYMAP_LAYERS_LEN <= 32, "zdkm: too many keymap layers");
BUILD_ASSERT(CONFIG_ZMK_COMBO_MAX_PRESSED_COMBOS > 0, "zdkm: enable at least one active combo");

#define ZDKM_LAYOUT DT_INST(0, zmk_physical_layout)
BUILD_ASSERT(DT_PROP_LEN(ZDKM_LAYOUT, keys) == ZMK_KEYMAP_LEN,
             "zdkm: the physical layout must describe every matrix position");

static const uint16_t matrix_map[] = DT_PROP(DT_PHANDLE(ZDKM_LAYOUT, transform), map);
enum {
    PHYSICAL_POSITION_COUNT = ZMK_KEYMAP_LEN,
    KEYMAP_LAYER_COUNT = ZMK_KEYMAP_LAYERS_LEN,
};

#define RECORD_VERSION 3
#define HEADER_SIZE 5
#define V1_ENTRY_SIZE 6
#define V2_ENTRY_SIZE 13
#define ENTRY_SIZE 15
#define CRC_SIZE 4
#define RECORD_SIZE (HEADER_SIZE + (ENTRY_SIZE + 2 * ZDKM_MAX_KEYS) * SLOT_COUNT + CRC_SIZE)
#define SETTINGS_KEY "zdkm/combos"
#define ACTION_BASE 0x100
#define STOCK_ACTION_BASE 0x200
#define MACRO_ACTION_BASE (STOCK_ACTION_BASE + ZDKM_MAX_COMBOS)
#define STOCK_ID_FLAG UINT32_C(0x80000000)

struct combo_action {
    uint16_t code;
    const char *label;
    struct zmk_behavior_binding binding;
};

#define CHECK_ACTION(node)                                                                        \
    BUILD_ASSERT(DT_PROP(node, action_id) > 0 && DT_PROP(node, action_id) <= UINT8_MAX,             \
                 "zdkm: action-id must be between 1 and 255");                                    \
    BUILD_ASSERT(sizeof(DT_PROP(node, display_name)) <= 49, "zdkm: action name is too long");       \
    BUILD_ASSERT(DT_PROP_LEN(node, bindings) == 1, "zdkm: action needs exactly one binding");
DT_FOREACH_STATUS_OKAY(zdkm_combo_action, CHECK_ACTION)

#define ACTION(node)                                                                              \
    {ACTION_BASE + DT_PROP(node, action_id), DT_PROP(node, display_name),                          \
     ZMK_KEYMAP_EXTRACT_BINDING(0, node)},
static const struct combo_action actions[] = {
    {0}, DT_FOREACH_STATUS_OKAY(zdkm_combo_action, ACTION)
};

#define MACRO_ACTION(slot, unused)                                                                \
    {MACRO_ACTION_BASE + (slot), "ZDKM マクロ " STRINGIFY(slot),                                    \
     {.behavior_dev = DEVICE_DT_NAME(DT_NODELABEL(zdkm_macro)), .param1 = (slot)}}
static const struct combo_action macro_actions[] = {
    LISTIFY(ZDKM_MACRO_SLOTS, MACRO_ACTION, (,))
};

struct stock_combo {
    struct zdkm_combo definition;
    struct combo_action action;
    const char *path;
};

#define EACH_STOCK_CONTAINER(node, fn) DT_FOREACH_CHILD_STATUS_OKAY(node, fn)
#define EACH_STOCK(fn) DT_FOREACH_STATUS_OKAY_VARGS(zmk_combos, EACH_STOCK_CONTAINER, fn)

#define CHECK_STOCK_LAYER(node, prop, idx)                                                         \
    BUILD_ASSERT(DT_PROP_BY_IDX(node, prop, idx) < KEYMAP_LAYER_COUNT &&                            \
                     DT_PROP_BY_IDX(node, prop, idx) >= 0,                                        \
                 "zdkm: invalid layer in " DT_NODE_PATH(node));
#define CHECK_STOCK_POSITION(node, prop, idx)                                                      \
    BUILD_ASSERT(DT_PROP_BY_IDX(node, prop, idx) < PHYSICAL_POSITION_COUNT &&                        \
                     DT_PROP_BY_IDX(node, prop, idx) >= 0,                                        \
                 "zdkm: invalid key position in " DT_NODE_PATH(node));
#define CHECK_STOCK(node)                                                                         \
    BUILD_ASSERT(DT_PROP_LEN(node, key_positions) >= 2 &&                                          \
                     DT_PROP_LEN(node, key_positions) <= ZDKM_MAX_KEYS,                           \
                 "zdkm: unsupported number of keys in " DT_NODE_PATH(node));                      \
    BUILD_ASSERT(DT_PROP_LEN(node, bindings) == 1, "zdkm: expected one binding in " DT_NODE_PATH(node)); \
    BUILD_ASSERT(DT_PROP(node, timeout_ms) > 0 && DT_PROP(node, timeout_ms) <= UINT16_MAX,          \
                 "zdkm: invalid timeout in " DT_NODE_PATH(node));                                 \
    BUILD_ASSERT(DT_PROP(node, require_prior_idle_ms) >= -1 &&                                     \
                     DT_PROP(node, require_prior_idle_ms) <= UINT16_MAX,                         \
                 "zdkm: invalid prior idle time in " DT_NODE_PATH(node));                         \
    DT_FOREACH_PROP_ELEM(node, key_positions, CHECK_STOCK_POSITION)                                 \
    COND_CODE_1(DT_NODE_HAS_PROP(node, layers),                                                     \
                (DT_FOREACH_PROP_ELEM(node, layers, CHECK_STOCK_LAYER)), ())
EACH_STOCK(CHECK_STOCK)

#define STOCK_LAYER_BIT(node, prop, idx) | BIT(DT_PROP_BY_IDX(node, prop, idx))
#define STOCK(node)                                                                               \
    {.definition = {                                                                              \
         .positions = DT_PROP(node, key_positions),                                               \
         .count = DT_PROP_LEN(node, key_positions),                                               \
         .timeout_ms = DT_PROP(node, timeout_ms),                                                 \
         .prior_idle_ms = MAX(0, DT_PROP(node, require_prior_idle_ms)),                              \
         .layers = 0 COND_CODE_1(DT_NODE_HAS_PROP(node, layers),                                    \
                                 (DT_FOREACH_PROP_ELEM(node, layers, STOCK_LAYER_BIT)), ()),      \
         .slow_release = DT_PROP(node, slow_release),                                             \
     },                                                                                          \
     .action = {.label = DT_NODE_FULL_NAME(node), .binding = ZMK_KEYMAP_EXTRACT_BINDING(0, node)}, \
     .path = DT_NODE_PATH(node)},
static const struct stock_combo stock[] = {
    {.path = NULL}, EACH_STOCK(STOCK)
};

#define STOCK_COUNT (ARRAY_SIZE(stock) - 1)
#define SLOT_COUNT MIN(ZDKM_MAX_COMBOS, STOCK_COUNT + CONFIG_ZDKM_COMBO_SLOTS)
BUILD_ASSERT(STOCK_COUNT <= ZDKM_MAX_COMBOS, "zdkm: at most 64 static combos can be imported");

/* Duplicate ids would make an existing saved action resolve to a different binding. */
static const struct combo_action *find_action(uint32_t code) {
    if (code >= MACRO_ACTION_BASE) {
        size_t index = code - MACRO_ACTION_BASE;
        return index < ARRAY_SIZE(macro_actions) ? &macro_actions[index] : NULL;
    }
    if (code >= STOCK_ACTION_BASE) {
        size_t index = code - STOCK_ACTION_BASE + 1;
        return index < ARRAY_SIZE(stock) ? &stock[index].action : NULL;
    }
#define ACTION_CASE(node) case ACTION_BASE + DT_PROP(node, action_id): break;
    switch (code) {
        DT_FOREACH_STATUS_OKAY(zdkm_combo_action, ACTION_CASE)
    default: return NULL;
    }
    for (size_t i = 1; i < ARRAY_SIZE(actions); ++i) {
        if (actions[i].code == code) return &actions[i];
    }
    return NULL;
}

size_t zdkm_action_count(void) { return ARRAY_SIZE(actions) - 1 + STOCK_COUNT + ARRAY_SIZE(macro_actions); }

const char *zdkm_action_at(size_t index, uint16_t *code) {
    if (index >= zdkm_action_count()) {
        return NULL;
    }
    if (index < ARRAY_SIZE(actions) - 1) {
        *code = actions[index + 1].code;
    } else if (index < ARRAY_SIZE(actions) - 1 + STOCK_COUNT) {
        *code = STOCK_ACTION_BASE + index - (ARRAY_SIZE(actions) - 1);
    } else {
        *code = MACRO_ACTION_BASE + index - (ARRAY_SIZE(actions) - 1 + STOCK_COUNT);
    }
    return find_action(*code)->label;
}

size_t zdkm_layer_count(void) { return ZMK_KEYMAP_LAYERS_LEN; }
size_t zdkm_slot_count(void) { return SLOT_COUNT; }

K_MUTEX_DEFINE(table_lock);
static struct zdkm_combo saved_table[SLOT_COUNT];
static struct zdkm_combo active_table[SLOT_COUNT];
static struct zdkm_combo write_table[SLOT_COUNT]; /* Single serial writer. */
static uint8_t write_record[RECORD_SIZE];

static bool settings_loaded;
static bool settings_found;
static bool invalid_record;
static uint32_t stock_ids[ARRAY_SIZE(stock)];
static bool stock_prepared;
static int stock_error;
static atomic_t apply_pending;

/* The ZMK local matrix and split central dispatch positions on the system work queue. */
static uint8_t held_positions[DIV_ROUND_UP(ZMK_KEYMAP_LEN, 8)];
static size_t held_count;
bool zdkm_keys_held(void) { return held_count != 0; }
static struct zdkm_sequence sequence;
static struct zmk_position_state_changed_event buffered[ZDKM_MAX_KEYS + 1];
static int64_t last_keypress = INT32_MIN;
static int64_t last_combo = INT32_MIN;

struct active_combo {
    uint8_t slot;
    uint32_t held;
};
static struct active_combo pressed_combos[CONFIG_ZMK_COMBO_MAX_PRESSED_COMBOS];
static size_t pressed_count;

size_t zdkm_position_count(void) { return ARRAY_SIZE(matrix_map); }

static uint32_t layout_checksum(void) {
    uint32_t crc = 0;
    for (size_t i = 0; i < ARRAY_SIZE(matrix_map); ++i) {
        uint8_t bytes[2];
        sys_put_le16(matrix_map[i], bytes);
        crc = crc32_ieee_update(crc, bytes, sizeof(bytes));
    }
    return crc;
}

uint32_t zdkm_backup_layout_id(void) {
    uint32_t crc = layout_checksum();
    for (size_t i = 0; i < zdkm_action_count(); ++i) {
        uint16_t code;
        const char *label = zdkm_action_at(i, &code);
        const struct zmk_behavior_binding *binding = &find_action(code)->binding;
        uint8_t fields[10];
        sys_put_le16(code, fields);
        sys_put_le32(binding->param1, fields + 2);
        sys_put_le32(binding->param2, fields + 6);
        crc = crc32_ieee_update(crc, fields, sizeof(fields));
        crc = crc32_ieee_update(crc, (const uint8_t *)label, strlen(label) + 1);
        crc = crc32_ieee_update(crc, (const uint8_t *)binding->behavior_dev,
                                strlen(binding->behavior_dev) + 1);
    }
    return crc;
}

uint16_t zdkm_keyboard_usage_limit(void) { return ZMK_HID_KEYBOARD_MAX_USAGE; }
uint16_t zdkm_consumer_usage_limit(void) { return ZMK_HID_CONSUMER_MAX_USAGE; }

uint32_t zdkm_key_binding(uint32_t output) {
    if (output >= 4 && output < ACTION_BASE) return ZMK_HID_USAGE(HID_USAGE_KEY, output);
    if ((output & UINT32_C(0xfe000000)) != ZDKM_PACKED_KEY) return 0;
    uint16_t usage = output;
    uint8_t modifiers = output >> 16;
    bool consumer = output & UINT32_C(0x01000000);
    if (consumer) {
        return usage && usage <= 0xfff && !modifiers ? ZMK_HID_USAGE(HID_USAGE_CONSUMER, usage) : 0;
    }
    return usage >= 4 && usage < ACTION_BASE ?
           ((uint32_t)modifiers << 24) | ZMK_HID_USAGE(HID_USAGE_KEY, usage) : 0;
}

bool zdkm_key_supported(uint32_t output) {
    uint32_t binding = zdkm_key_binding(output);
    if (!binding) return false;
    uint16_t usage = binding;
    if ((uint8_t)(binding >> 16) == HID_USAGE_CONSUMER) return usage <= zdkm_consumer_usage_limit();
    return usage <= zdkm_keyboard_usage_limit() || (usage >= 0xe0 && usage <= 0xe7);
}

static bool valid_output(uint32_t output) {
    return zdkm_key_binding(output) || find_action(output);
}

bool zdkm_supports_extended_keys(void) {
    return ZMK_HID_KEYBOARD_MAX_USAGE >= HID_USAGE_KEY_KEYBOARD_INTERNATIONAL5;
}

static bool valid_combo(const struct zdkm_combo *combo) {
    if (!valid_output(combo->output) || combo->count < 2 || combo->count > ZDKM_MAX_KEYS ||
        !combo->timeout_ms || (uint64_t)combo->layers >= (1ULL << ZMK_KEYMAP_LAYERS_LEN)) {
        return false;
    }
    for (size_t i = 0; i < combo->count; ++i) {
        if (combo->positions[i] >= zdkm_position_count() ||
            (i && combo->positions[i - 1] >= combo->positions[i])) {
            return false;
        }
    }
    return true;
}

static bool same_positions(const struct zdkm_combo *a, const struct zdkm_combo *b) {
    return a->count == b->count &&
           memcmp(a->positions, b->positions, a->count * sizeof(a->positions[0])) == 0;
}

static bool same_chord(const struct zdkm_combo *a, const struct zdkm_combo *b) {
    return a->count && (!a->layers || !b->layers || (a->layers & b->layers)) && same_positions(a, b);
}

static bool same_definition(const struct zdkm_combo *a, const struct zdkm_combo *b) {
    return a->output == b->output && a->timeout_ms == b->timeout_ms &&
           a->prior_idle_ms == b->prior_idle_ms && a->layers == b->layers &&
           a->slow_release == b->slow_release && same_positions(a, b);
}

bool zdkm_is_legacy(const struct zdkm_combo *combo) {
    return !combo->count || (combo->count == 2 && combo->timeout_ms == CONFIG_ZDKM_COMBO_TIMEOUT_MS &&
           !combo->prior_idle_ms && !combo->layers && !combo->slow_release && combo->output < ACTION_BASE);
}

static struct zdkm_combo stock_definition(size_t index) {
    const struct zdkm_combo *source = &stock[index].definition;
    struct zdkm_combo combo = *source;
    combo.output = STOCK_ACTION_BASE + index - 1;
    combo.count = 0;
    for (size_t i = 0; i < source->count; ++i) {
        if (!zdkm_add_position(&combo, source->positions[i])) {
            combo.count = 0;
            break;
        }
    }
    return combo;
}

static uint32_t stock_binding_id(const struct stock_combo *entry) {
    const struct zmk_behavior_binding *binding = &entry->action.binding;
    uint32_t crc = crc32_ieee((const uint8_t *)entry->path, strlen(entry->path) + 1);
    crc = crc32_ieee_update(crc, (const uint8_t *)binding->behavior_dev,
                            strlen(binding->behavior_dev) + 1);
    uint8_t params[8];
    sys_put_le32(binding->param1, params);
    sys_put_le32(binding->param2, params + 4);
    return STOCK_ID_FLAG | crc32_ieee_update(crc, params, sizeof(params));
}

/* Compile order assigns wire codes. Persist the source identity so reordering cannot retarget them. */
static int prepare_stock(void) {
    if (stock_prepared) {
        return stock_error;
    }
    stock_prepared = true;
    for (size_t i = 1; i < ARRAY_SIZE(stock); ++i) {
        struct zdkm_combo combo = stock_definition(i);
        if (!valid_combo(&combo)) {
            LOG_ERR("Invalid static combo %s", stock[i].path);
            return stock_error = -EINVAL;
        }
        stock_ids[i] = stock_binding_id(&stock[i]);
        for (size_t j = 1; j < i; ++j) {
            if (stock_ids[j] == stock_ids[i]) {
                LOG_ERR("Static combo binding ID collision: %s and %s", stock[j].path, stock[i].path);
                return stock_error = -EEXIST;
            }
        }
    }
    return 0;
}

static void copy_stock(struct zdkm_combo *table) {
    memset(table, 0, sizeof(saved_table));
    for (size_t i = 1; i < ARRAY_SIZE(stock); ++i) {
        table[i - 1] = stock_definition(i);
    }
}

static void merge_legacy_stock(struct zdkm_combo *table) {
    for (size_t i = 1; i < ARRAY_SIZE(stock); ++i) {
        struct zdkm_combo combo = stock_definition(i);
        size_t empty = SLOT_COUNT;
        bool conflicts = false;
        for (size_t j = 0; j < SLOT_COUNT; ++j) {
            if (!table[j].count && empty == SLOT_COUNT) {
                empty = j;
            }
            /* Older firmware only had explicitly registered actions and direct key outputs. */
            if (table[j].output < STOCK_ACTION_BASE && same_chord(&table[j], &combo)) {
                conflicts = true;
                break;
            }
        }
        if (conflicts) {
            continue;
        }
        if (empty < SLOT_COUNT) {
            table[empty] = combo;
        } else {
            LOG_WRN("No free slot for static combo %s; existing settings were preserved", stock[i].path);
        }
    }
}

static uint32_t decode_output(uint32_t output) {
    if (zdkm_key_binding(output) || output < STOCK_ACTION_BASE ||
        (output >= MACRO_ACTION_BASE && output < MACRO_ACTION_BASE + ZDKM_MACRO_SLOTS)) {
        return output;
    }
    for (size_t i = 1; i < ARRAY_SIZE(stock); ++i) {
        if (stock_ids[i] == output) {
            return STOCK_ACTION_BASE + i - 1;
        }
    }
    return 0;
}

static int decode_table(const uint8_t *data, size_t len, struct zdkm_combo *table) {
    if (len < HEADER_SIZE + CRC_SIZE || data[0] < 1 || data[0] > RECORD_VERSION ||
        sys_get_le32(data + 1) != layout_checksum() ||
        sys_get_le32(data + len - CRC_SIZE) != crc32_ieee(data, len - CRC_SIZE)) {
        return -EINVAL;
    }
    const size_t end = len - CRC_SIZE;
    for (size_t offset = HEADER_SIZE; offset < end;) {
        const uint8_t *entry = data + offset;
        uint8_t slot = entry[0];
        struct zdkm_combo combo = {0};
        if (data[0] == 1) {
            if (end - offset < V1_ENTRY_SIZE) return -EINVAL;
            combo.count = 2;
            combo.timeout_ms = CONFIG_ZDKM_COMBO_TIMEOUT_MS;
            combo.output = entry[5];
            combo.positions[0] = sys_get_le16(entry + 1);
            combo.positions[1] = sys_get_le16(entry + 3);
            offset += V1_ENTRY_SIZE;
        } else {
            size_t entry_size = data[0] == 2 ? V2_ENTRY_SIZE : ENTRY_SIZE;
            if (end - offset < entry_size || entry[1] > ZDKM_MAX_KEYS || entry[2] > 1 ||
                end - offset - entry_size < 2u * entry[1]) return -EINVAL;
            combo.count = entry[1];
            combo.slow_release = entry[2];
            combo.timeout_ms = sys_get_le16(entry + 3);
            combo.prior_idle_ms = sys_get_le16(entry + 5);
            combo.layers = sys_get_le32(entry + 7);
            combo.output = decode_output(data[0] == 2 ? sys_get_le16(entry + 11) :
                                          sys_get_le32(entry + 11));
            for (size_t i = 0; i < combo.count; ++i) {
                combo.positions[i] = sys_get_le16(entry + entry_size + 2 * i);
            }
            offset += entry_size + 2u * combo.count;
        }
        if (slot >= SLOT_COUNT || table[slot].count || !valid_combo(&combo)) return -EINVAL;
        table[slot] = combo;
    }
    return 0;
}

static size_t encode_table(uint8_t *data, const struct zdkm_combo *table) {
    data[0] = RECORD_VERSION;
    sys_put_le32(layout_checksum(), data + 1);
    size_t offset = HEADER_SIZE;
    for (uint8_t slot = 0; slot < SLOT_COUNT; ++slot) {
        const struct zdkm_combo *combo = &table[slot];
        if (!combo->count) continue;
        uint8_t *entry = data + offset;
        entry[0] = slot;
        entry[1] = combo->count;
        entry[2] = combo->slow_release;
        sys_put_le16(combo->timeout_ms, entry + 3);
        sys_put_le16(combo->prior_idle_ms, entry + 5);
        sys_put_le32(combo->layers, entry + 7);
        bool is_stock = combo->output >= STOCK_ACTION_BASE && combo->output < MACRO_ACTION_BASE;
        uint32_t output = is_stock ? stock_ids[combo->output - STOCK_ACTION_BASE + 1] : combo->output;
        sys_put_le32(output, entry + 11);
        for (size_t i = 0; i < combo->count; ++i) {
            sys_put_le16(combo->positions[i], entry + ENTRY_SIZE + 2 * i);
        }
        offset += ENTRY_SIZE + 2 * combo->count;
    }
    sys_put_le32(crc32_ieee(data, offset), data + offset);
    return offset + CRC_SIZE;
}

static void apply_table(struct k_work *work) {
    ARG_UNUSED(work);
    if (held_count || sequence.count || pressed_count) return;
    k_mutex_lock(&table_lock, K_FOREVER);
    if (atomic_get(&apply_pending)) {
        memcpy(active_table, saved_table, sizeof(active_table));
        for (size_t slot = 0; slot < SLOT_COUNT; ++slot) {
            uint32_t output = active_table[slot].output;
            if (zdkm_key_binding(output) && !zdkm_key_supported(output)) active_table[slot].count = 0;
        }
        atomic_clear(&apply_pending);
    }
    k_mutex_unlock(&table_lock);
}

static K_WORK_DEFINE(apply_work, apply_table);

static int load_combos(const char *name, size_t len, settings_read_cb read, void *arg) {
    if (strcmp(name, "combos") != 0) return -ENOENT;
    static uint8_t record[RECORD_SIZE]; /* The Settings backend serializes load callbacks. */
    bool read_ok = len <= sizeof(record) && read(arg, record, len) == (ssize_t)len;
    k_mutex_lock(&table_lock, K_FOREVER);
    settings_found = true;
    memset(saved_table, 0, sizeof(saved_table));
    invalid_record = prepare_stock() || !read_ok || decode_table(record, len, saved_table) != 0;
    if (invalid_record) {
        memset(saved_table, 0, sizeof(saved_table));
        LOG_ERR("Invalid or incompatible dynamic combo settings");
    } else if (record[0] < RECORD_VERSION) {
        merge_legacy_stock(saved_table);
    }
    k_mutex_unlock(&table_lock);
    return 0;
}

static int finish_loading_combos(void) {
    k_mutex_lock(&table_lock, K_FOREVER);
    if (!settings_found) {
        invalid_record = prepare_stock() != 0;
        if (!invalid_record) {
            copy_stock(saved_table);
        }
    }
    settings_loaded = true;
    atomic_set(&apply_pending, 1);
    k_mutex_unlock(&table_lock);
    k_work_submit(&apply_work);
    return 0;
}

SETTINGS_STATIC_HANDLER_DEFINE(zdkm, "zdkm", NULL, load_combos, finish_loading_combos, NULL);

static enum zdkm_status settings_status(void) {
    if (!settings_loaded) return ZDKM_LOADING;
    if (invalid_record) return ZDKM_INVALID;
    return atomic_get(&apply_pending) ? ZDKM_PENDING : ZDKM_ACTIVE;
}

enum zdkm_status zdkm_get_status(void) {
    k_mutex_lock(&table_lock, K_FOREVER);
    enum zdkm_status status = settings_status();
    k_mutex_unlock(&table_lock);
    return status;
}

struct zdkm_combo zdkm_get_combo(size_t slot) {
    k_mutex_lock(&table_lock, K_FOREVER);
    struct zdkm_combo combo = saved_table[slot];
    k_mutex_unlock(&table_lock);
    return combo;
}

int zdkm_save(int slot, struct zdkm_combo combo) {
    if (slot < -1 || slot >= SLOT_COUNT || (combo.count && !valid_combo(&combo))) return -EINVAL;
    if (combo.count && zdkm_key_binding(combo.output) && !zdkm_key_supported(combo.output)) {
        return -ENOTSUP;
    }

    k_mutex_lock(&table_lock, K_FOREVER);
    enum zdkm_status status = settings_status();
    memcpy(write_table, saved_table, sizeof(write_table));
    k_mutex_unlock(&table_lock);
    if (status == ZDKM_LOADING || status == ZDKM_PENDING) return -EBUSY;
    if (status == ZDKM_INVALID && slot >= 0) return -EBADMSG;

    int err;
    if (slot < 0) {
        if (stock_error) {
            return stock_error;
        }
        copy_stock(write_table);
        err = settings_delete(SETTINGS_KEY);
    } else {
        const struct zdkm_combo *previous = &write_table[slot];
        if (same_definition(previous, &combo)) return 0;
        if (!same_positions(previous, &combo) || previous->layers != combo.layers) {
            for (int i = 0; i < SLOT_COUNT; ++i) {
                if (i != slot && same_chord(&write_table[i], &combo)) return -EEXIST;
            }
        }
        write_table[slot] = combo;
        size_t length = encode_table(write_record, write_table);
        err = settings_save_one(SETTINGS_KEY, write_record, length);
    }
    if (err < 0) {
        LOG_ERR("Could not persist dynamic combo settings (%d)", err);
        return err;
    }
    k_mutex_lock(&table_lock, K_FOREVER);
    memcpy(saved_table, write_table, sizeof(saved_table));
    invalid_record = false;
    atomic_set(&apply_pending, 1);
    k_mutex_unlock(&table_lock);
    k_work_submit(&apply_work);
    return 0;
}

static void invoke_output(uint8_t slot, int64_t timestamp, bool pressed) {
    const uint32_t output = active_table[slot].output;
    struct zmk_behavior_binding binding = {
        .behavior_dev = DEVICE_DT_NAME(DT_NODELABEL(kp)),
        .param1 = zdkm_key_binding(output),
    };
    if (!binding.param1) {
        const struct combo_action *action = find_action(output);
        if (!action) return;
        binding = action->binding;
    }
    struct zmk_behavior_binding_event event = {
        /* Keep dynamic combo events distinct from ZMK's static virtual position ranges. */
        .position = INT32_MAX - slot,
        .timestamp = timestamp,
#if IS_ENABLED(CONFIG_ZMK_SPLIT)
        .source = ZMK_POSITION_STATE_CHANGE_SOURCE_LOCAL,
#endif
    };
    int err = zmk_behavior_invoke_binding(&binding, event, pressed);
    if (err < 0) LOG_ERR("Could not dispatch combo output (%d)", err);
}

static bool process_press(const struct zmk_position_state_changed_event *event);
static void combo_timeout(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(timeout_work, combo_timeout);

struct replay_item {
    struct zmk_position_state_changed_event event;
    bool downstream;
};
static struct replay_item replay_queue[ARRAY_SIZE(buffered)];
static size_t replay_queued;
static bool draining_replay;

static void replay_presses(size_t first, size_t count) {
    if (count) {
        /* A nested resolution can only enqueue presses already popped from this queue. */
        memmove(replay_queue + count, replay_queue, replay_queued * sizeof(replay_queue[0]));
        for (size_t i = 0; i < count; ++i) {
            replay_queue[i] = (struct replay_item){buffered[first + i], i == 0};
        }
        replay_queued += count;
    }
    if (draining_replay) {
        return;
    }
    draining_replay = true;
    while (replay_queued) {
        struct replay_item next = replay_queue[0];
        --replay_queued;
        memmove(replay_queue, replay_queue + 1, replay_queued * sizeof(replay_queue[0]));
        /* The first miss continues downstream. Later presses can start another combo. */
        if (next.downstream || !process_press(&next.event)) {
            int err = ZMK_EVENT_RELEASE(next.event);
            if (err < 0) {
                LOG_ERR("Could not replay position event (%d)", err);
            }
        }
    }
    draining_replay = false;
}

static size_t resolve_sequence(void) {
    if (!sequence.count) return 0;
    k_work_cancel_delayable(&timeout_work);
    uint8_t completed = sequence.completed;
    size_t replay_count = sequence.count;
    size_t used = 0;
    int64_t started = sequence.started;
    sequence = (struct zdkm_sequence){0};

    if (completed && pressed_count < ARRAY_SIZE(pressed_combos)) {
        uint8_t slot = completed - 1;
        used = active_table[slot].count;
        pressed_combos[pressed_count++] = (struct active_combo){slot, (1u << used) - 1};
        replay_count -= used;
        last_combo = started;
        invoke_output(slot, started, true);
    }
    replay_presses(used, replay_count);
    return replay_count;
}

static void schedule_timeout(void) {
    int64_t deadline = zdkm_deadline(&sequence, active_table, SLOT_COUNT);
    if (deadline != INT64_MAX) {
        k_work_reschedule(&timeout_work, K_MSEC(MAX(0, deadline - k_uptime_get())));
    }
}

static void combo_timeout(struct k_work *work) {
    ARG_UNUSED(work);
    if (!sequence.count) return;
    if (zdkm_prune(&sequence, active_table, SLOT_COUNT, k_uptime_get())) {
        schedule_timeout();
    } else {
        resolve_sequence();
    }
}

static bool process_press(const struct zmk_position_state_changed_event *event) {
    enum zdkm_match match = zdkm_press(&sequence, active_table, SLOT_COUNT, event->data.position,
                                      event->data.timestamp, zmk_keymap_highest_layer_active(),
                                      last_keypress);
    if (match == ZDKM_PASS) return false;
    buffered[sequence.count - 1] = *event;
    if (match == ZDKM_RESOLVE) {
        resolve_sequence();
    } else {
        schedule_timeout();
    }
    return true;
}

static bool release_active(uint16_t position, int64_t timestamp) {
    for (size_t i = 0; i < pressed_count; ++i) {
        struct active_combo *active = &pressed_combos[i];
        enum zdkm_release release = zdkm_release_key(&active_table[active->slot],
                                                     &active->held, position);
        if (release == ZDKM_NOT_HELD) {
            continue;
        }
        if (release == ZDKM_RELEASE_OUTPUT) {
            invoke_output(active->slot, timestamp, false);
        }
        if (!active->held) {
            pressed_combos[i] = pressed_combos[--pressed_count];
        }
        return true;
    }
    return false;
}

static bool track_press(uint16_t position) {
    uint8_t *byte = &held_positions[position / 8];
    uint8_t bit = BIT(position % 8);
    if (*byte & bit) return false;
    *byte |= bit;
    ++held_count;
    return true;
}

static void track_release(uint16_t position) {
    uint8_t *byte = &held_positions[position / 8];
    uint8_t bit = BIT(position % 8);
    if (*byte & bit) {
        *byte &= (uint8_t)~bit;
        if (--held_count == 0 && atomic_get(&apply_pending)) k_work_submit(&apply_work);
    }
}

static int position_listener(const zmk_event_t *event) {
    const struct zmk_keycode_state_changed *key = as_zmk_keycode_state_changed(event);
    if (key && key->state && key->timestamp > last_combo && !is_mod(key->usage_page, key->keycode)) {
        last_keypress = key->timestamp;
    }
    const struct zmk_position_state_changed *position = as_zmk_position_state_changed(event);
    if (!position || position->position >= ZMK_KEYMAP_LEN) return ZMK_EV_EVENT_BUBBLE;
    if (position->state) {
        if (!track_press(position->position)) return ZMK_EV_EVENT_CAPTURED;
        struct zmk_position_state_changed_event copy = copy_raised_zmk_position_state_changed(position);
        return process_press(&copy) ? ZMK_EV_EVENT_CAPTURED : ZMK_EV_EVENT_BUBBLE;
    }

    track_release(position->position);
    /* A replay can itself create a new pending sequence before this key-up is delivered. */
    for (;;) {
        size_t replayed = resolve_sequence();
        if (release_active(position->position, position->timestamp)) return ZMK_EV_EVENT_HANDLED;
        if (replayed <= 1) return ZMK_EV_EVENT_BUBBLE;
    }
}

ZMK_LISTENER(zdkm_combo, position_listener);
ZMK_SUBSCRIPTION(zdkm_combo, zmk_position_state_changed);
ZMK_SUBSCRIPTION(zdkm_combo, zmk_keycode_state_changed);

#define DT_DRV_COMPAT zdkm_behavior_unlock

static int unlock_pressed(struct zmk_behavior_binding *binding,
                          struct zmk_behavior_binding_event event) {
    ARG_UNUSED(binding);
    ARG_UNUSED(event);
    zdkm_authorize();
    return ZMK_BEHAVIOR_OPAQUE;
}

static int unlock_released(struct zmk_behavior_binding *binding,
                           struct zmk_behavior_binding_event event) {
    ARG_UNUSED(binding);
    ARG_UNUSED(event);
    return ZMK_BEHAVIOR_OPAQUE;
}

static const struct behavior_driver_api unlock_api = {
    .binding_pressed = unlock_pressed,
    .binding_released = unlock_released,
#if IS_ENABLED(CONFIG_ZMK_BEHAVIOR_METADATA)
    .get_parameter_metadata = zmk_behavior_get_empty_param_metadata,
#endif
};

BEHAVIOR_DT_INST_DEFINE(0, NULL, NULL, NULL, NULL, POST_KERNEL, CONFIG_KERNEL_INIT_PRIORITY_DEFAULT,
                        &unlock_api);
