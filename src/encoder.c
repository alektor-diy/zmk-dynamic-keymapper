#include <errno.h>
#include <zephyr/devicetree.h>

#include "encoder.h"

#if DT_HAS_COMPAT_STATUS_OKAY(zmk_keymap_sensors) && IS_ENABLED(CONFIG_ZMK_BEHAVIOR_SENSOR_ROTATE_VAR)

#include <stdlib.h>
#include <string.h>
#include <drivers/behavior.h>
#include <zephyr/kernel.h>
#include <zephyr/settings/settings.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/printk.h>
#include <zmk/keymap.h>
#include <zmk/virtual_key_position.h>

#include "runtime.h"

BUILD_ASSERT(ZMK_KEYMAP_SENSORS_LEN <= UINT8_MAX, "zdkm: too many keymap sensors");

#define ENCODER_SETTINGS "zdkm_encoder"
#define RECORD_VERSION 1
#define RECORD_SIZE 9
#define ROTATE_KEY DT_NODELABEL(inc_dec_kp)
#define STOCK_VALUE(layer, i, cell)                                                                \
    (DT_SAME_NODE(DT_PHANDLE_BY_IDX(layer, sensor_bindings, i), ROTATE_KEY)                           \
         ? DT_PHA_BY_IDX_OR(layer, sensor_bindings, i, cell, 0) : 0)
#define STOCK_CODE(i, layer)                                                                       \
    COND_CODE_1(DT_PROP_HAS_IDX(layer, sensor_bindings, i),                                          \
                ({STOCK_VALUE(layer, i, param1), STOCK_VALUE(layer, i, param2)}), ({0}))
#define STOCK_LAYER(layer) {LISTIFY(ZMK_KEYMAP_SENSORS_LEN, STOCK_CODE, (,), layer)}

#if DT_NODE_HAS_STATUS(ROTATE_KEY, okay)
static const struct zdkm_encoder_codes stock[ZMK_KEYMAP_LAYERS_LEN][ZMK_KEYMAP_SENSORS_LEN] = {
    DT_FOREACH_CHILD_SEP(DT_INST(0, zmk_keymap), STOCK_LAYER, (,))};
#endif

static struct zdkm_encoder_codes overrides[ZMK_KEYMAP_LAYERS_LEN][ZMK_KEYMAP_SENSORS_LEN];
static struct k_spinlock encoder_lock;

unsigned int zdkm_encoder_count(void) {
    return DT_NODE_HAS_STATUS(ROTATE_KEY, okay) ? ZMK_KEYMAP_SENSORS_LEN : 0;
}

static const struct zdkm_encoder_codes *stock_at(uint8_t layer, uint8_t index) {
#if DT_NODE_HAS_STATUS(ROTATE_KEY, okay)
    if (layer < ARRAY_SIZE(stock) && index < ZMK_KEYMAP_SENSORS_LEN &&
        stock[layer][index].clockwise && stock[layer][index].counterclockwise) {
        return &stock[layer][index];
    }
#endif
    return NULL;
}

static struct zdkm_encoder_codes read_override(uint8_t layer, uint8_t index) {
    k_spinlock_key_t key = k_spin_lock(&encoder_lock);
    struct zdkm_encoder_codes codes = overrides[layer][index];
    k_spin_unlock(&encoder_lock, key);
    return codes;
}

static void write_override(uint8_t layer, uint8_t index, struct zdkm_encoder_codes codes) {
    k_spinlock_key_t key = k_spin_lock(&encoder_lock);
    overrides[layer][index] = codes;
    k_spin_unlock(&encoder_lock, key);
}

int zdkm_encoder_get(uint8_t layer, uint8_t index, struct zdkm_encoder_codes *codes) {
    const struct zdkm_encoder_codes *defaults = stock_at(layer, index);
    if (!defaults) return -ENOENT;
    *codes = read_override(layer, index);
    if (!codes->clockwise) *codes = *defaults;
    return 0;
}

static bool valid_keycode(uint32_t code) {
    struct zmk_behavior_binding binding = {
        .behavior_dev = DEVICE_DT_NAME(DT_NODELABEL(kp)), .param1 = code,
    };
    return code && zmk_behavior_validate_binding(&binding) >= 0;
}

int zdkm_encoder_save(uint8_t layer, uint8_t index, const struct zdkm_encoder_codes *codes) {
    const struct zdkm_encoder_codes *defaults = stock_at(layer, index);
    if (!defaults || !valid_keycode(codes->clockwise) || !valid_keycode(codes->counterclockwise)) {
        return -EINVAL;
    }
    if (zdkm_get_status() == ZDKM_LOADING) return -EBUSY;

    struct zdkm_encoder_codes current;
    zdkm_encoder_get(layer, index, &current);
    if (codes->clockwise == current.clockwise && codes->counterclockwise == current.counterclockwise) {
        return 0;
    }

    char key[sizeof(ENCODER_SETTINGS "/255/255")];
    snprintk(key, sizeof(key), ENCODER_SETTINGS "/%u/%u", layer, index);
    const bool is_stock = codes->clockwise == defaults->clockwise &&
                          codes->counterclockwise == defaults->counterclockwise;
    uint8_t record[RECORD_SIZE] = {RECORD_VERSION};
    sys_put_le32(codes->clockwise, &record[1]);
    sys_put_le32(codes->counterclockwise, &record[5]);
    int err = is_stock ? settings_delete(key) : settings_save_one(key, record, sizeof(record));
    if (err < 0) return err;
    write_override(layer, index, is_stock ? (struct zdkm_encoder_codes){0} : *codes);
    return 0;
}

static int load_encoder(const char *name, size_t len, settings_read_cb read_cb, void *arg) {
    if (!name || *name < '0' || *name > '9') return -ENOENT;
    char *end;
    unsigned long layer = strtoul(name, &end, 10);
    if (*end != '/' || end[1] < '0' || end[1] > '9') return -ENOENT;
    unsigned long index = strtoul(end + 1, &end, 10);
    if (*end || layer >= ZMK_KEYMAP_LAYERS_LEN || index >= zdkm_encoder_count() ||
        !stock_at(layer, index)) return -ENOENT;

    uint8_t record[RECORD_SIZE];
    if (!len) return 0;
    if (len != sizeof(record) || read_cb(arg, record, len) != sizeof(record) ||
        record[0] != RECORD_VERSION) return -EINVAL;
    struct zdkm_encoder_codes codes = {sys_get_le32(&record[1]), sys_get_le32(&record[5])};
    if (!valid_keycode(codes.clockwise) || !valid_keycode(codes.counterclockwise)) return -EINVAL;
    write_override(layer, index, codes);
    return 0;
}
SETTINGS_STATIC_HANDLER_DEFINE(zdkm_encoder, ENCODER_SETTINGS, NULL, load_encoder, NULL, NULL);

int __real_zmk_behavior_sensor_rotate_common_process(struct zmk_behavior_binding *binding,
    struct zmk_behavior_binding_event event, enum behavior_sensor_binding_process_mode mode);

/* Keep ZMK's sensor accumulation, layer fallback and tap queue. Only override the two
 * keycode parameters on the copy passed to the stock rotation behavior.
 */
int __wrap_zmk_behavior_sensor_rotate_common_process(struct zmk_behavior_binding *binding,
    struct zmk_behavior_binding_event event, enum behavior_sensor_binding_process_mode mode) {
#if DT_NODE_HAS_STATUS(ROTATE_KEY, okay)
    uint32_t index = ZMK_SENSOR_POSITION_FROM_VIRTUAL_KEY_POSITION(event.position);
    struct zmk_behavior_binding updated;
    if (mode == BEHAVIOR_SENSOR_BINDING_PROCESS_MODE_TRIGGER && index < ZMK_KEYMAP_SENSORS_LEN &&
        event.layer < ZMK_KEYMAP_LAYERS_LEN && strcmp(binding->behavior_dev, DEVICE_DT_NAME(ROTATE_KEY)) == 0) {
        struct zdkm_encoder_codes codes = read_override(event.layer, index);
        if (codes.clockwise) {
            updated = *binding;
            updated.param1 = codes.clockwise;
            updated.param2 = codes.counterclockwise;
            binding = &updated;
        }
    }
#endif
    return __real_zmk_behavior_sensor_rotate_common_process(binding, event, mode);
}

#else

unsigned int zdkm_encoder_count(void) { return 0; }

int zdkm_encoder_get(uint8_t layer, uint8_t index, struct zdkm_encoder_codes *codes) {
    return -ENOENT;
}

int zdkm_encoder_save(uint8_t layer, uint8_t index, const struct zdkm_encoder_codes *codes) {
    return -EINVAL;
}

#endif
