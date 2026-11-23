#define DT_DRV_COMPAT zdkm_behavior_macro

#include <errno.h>
#include <string.h>

#include <drivers/behavior.h>
#include <dt-bindings/zmk/hid_usage_pages.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/settings/settings.h>
#include <zephyr/sys/byteorder.h>

#include "macro.h"
#include "runtime.h"

LOG_MODULE_DECLARE(zdkm);

#define MACRO_SETTINGS "zdkm_macro"
#define MACRO_VERSION 2
#define MACRO_RECORD_MAX (2 + 4 * ZDKM_MACRO_STEPS)
#define KEY_INTERVAL_MS 20

static struct zdkm_macro macros[ZDKM_MACRO_SLOTS];
static uint8_t invalid_slots;
K_MUTEX_DEFINE(macros_lock);

static uint8_t step_operation(uint32_t step) {
    return step & ZDKM_PACKED_KEY ? step >> 30 : step >> 16;
}

static uint32_t step_value(uint32_t step) {
    return step & ZDKM_PACKED_KEY ? step & ZDKM_KEY_PAYLOAD : (uint16_t)step;
}

static bool valid(const struct zdkm_macro *macro, bool check_support) {
    if (macro->count > ZDKM_MACRO_STEPS) return false;
    uint32_t pressed[ZDKM_MACRO_STEPS];
    size_t held = 0;
    for (size_t i = 0; i < macro->count; ++i) {
        uint32_t step = macro->steps[i];
        if (!(step & ZDKM_PACKED_KEY) && step >> 16 > ZDKM_MACRO_WAIT) return false;
        uint8_t op = step_operation(step);
        uint32_t value = step_value(step);
        if (op == ZDKM_MACRO_WAIT) {
            if (value < 1 || value > ZDKM_MACRO_MAX_WAIT) return false;
            continue;
        }
        uint32_t binding = zdkm_key_binding(value);
        if (!binding || (check_support && !zdkm_key_supported(value))) return false;
        size_t index = 0;
        while (index < held && (pressed[index] & 0xffffff) != (binding & 0xffffff)) ++index;
        switch (op) {
        case ZDKM_MACRO_TAP:
            if (index < held) return false;
            break;
        case ZDKM_MACRO_PRESS:
            if (index < held) return false;
            pressed[held++] = binding;
            break;
        case ZDKM_MACRO_RELEASE:
            if (index == held || pressed[index] != binding) return false;
            pressed[index] = pressed[--held];
            break;
        default:
            return false;
        }
    }
    return held == 0;
}

int zdkm_macro_get(uint8_t slot, struct zdkm_macro *macro) {
    if (slot >= ARRAY_SIZE(macros)) return -EINVAL;
    k_mutex_lock(&macros_lock, K_FOREVER);
    int err = (invalid_slots & BIT(slot)) ? -EBADMSG : 0;
    if (!err) *macro = macros[slot];
    k_mutex_unlock(&macros_lock);
    return err;
}

int zdkm_macro_save(uint8_t slot, const struct zdkm_macro *macro) {
    if (slot >= ARRAY_SIZE(macros) || !valid(macro, false)) return -EINVAL;
    if (!valid(macro, true)) return -ENOTSUP;
    if (zdkm_get_status() == ZDKM_LOADING) return -EBUSY;
    char key[] = MACRO_SETTINGS "/0";
    key[sizeof(key) - 2] += slot;
    uint8_t record[MACRO_RECORD_MAX] = {1, macro->count};
    for (size_t i = 0; i < macro->count; ++i) {
        if (macro->steps[i] & ZDKM_PACKED_KEY) record[0] = MACRO_VERSION;
    }
    size_t width = record[0] == 1 ? 3 : 4;
    for (size_t i = 0; i < macro->count; ++i) {
        if (width == 3) sys_put_le24(macro->steps[i], &record[2 + width * i]);
        else sys_put_le32(macro->steps[i], &record[2 + width * i]);
    }
    int err = macro->count ? settings_save_one(key, record, 2 + width * macro->count) : settings_delete(key);
    if (err < 0) return err;
    k_mutex_lock(&macros_lock, K_FOREVER);
    macros[slot] = *macro;
    invalid_slots &= ~BIT(slot);
    k_mutex_unlock(&macros_lock);
    return 0;
}

static int load_macro(const char *name, size_t len, settings_read_cb read_cb, void *arg) {
    if (strlen(name) != 1 || name[0] < '0' || name[0] >= '0' + ZDKM_MACRO_SLOTS) return -ENOENT;
    uint8_t slot = name[0] - '0';
    uint8_t record[MACRO_RECORD_MAX];
    struct zdkm_macro macro = {0};
    if (len == 0) return 0;
    if (len >= 2 && len <= sizeof(record) && read_cb(arg, record, len) == len &&
        (record[0] == 1 || record[0] == MACRO_VERSION)) {
        size_t width = record[0] == 1 ? 3 : 4;
        macro.count = record[1];
        if (macro.count <= ZDKM_MACRO_STEPS && len == 2 + width * macro.count) {
            for (size_t i = 0; i < macro.count; ++i) {
                const uint8_t *bytes = &record[2 + width * i];
                macro.steps[i] = width == 3 ? sys_get_le24(bytes) : sys_get_le32(bytes);
            }
            if (valid(&macro, false)) {
                macros[slot] = macro;
                return 0;
            }
        }
    }
    invalid_slots |= BIT(slot);
    LOG_ERR("Invalid saved ZDKM macro slot %u", slot);
    return 0;
}
SETTINGS_STATIC_HANDLER_DEFINE(zdkm_macro, MACRO_SETTINGS, NULL, load_macro, NULL, NULL);

/* Playback owns a snapshot so editing a slot cannot interrupt a press/release pair. */
static struct zdkm_macro playing;
static struct zmk_behavior_binding_event trigger;
static uint8_t next_step;
static bool release_tap;
static atomic_t running;

static void play_step(struct k_work *work);
K_WORK_DELAYABLE_DEFINE(play_work, play_step);

static void play_step(struct k_work *work) {
    if (next_step == playing.count) {
        atomic_clear(&running);
        return;
    }
    uint32_t step = playing.steps[next_step];
    uint8_t op = step_operation(step);
    uint32_t value = step_value(step);
    uint16_t delay = KEY_INTERVAL_MS;
    if (op == ZDKM_MACRO_WAIT) {
        delay = value;
    } else {
        struct zmk_behavior_binding binding = {
            .behavior_dev = DEVICE_DT_NAME(DT_NODELABEL(kp)),
            .param1 = zdkm_key_binding(value),
        };
        trigger.timestamp = k_uptime_get();
        int err = zmk_behavior_invoke_binding(&binding, trigger, op != ZDKM_MACRO_RELEASE && !release_tap);
        if (err < 0) LOG_ERR("ZDKM macro key step failed: %d", err);
    }
    if (op == ZDKM_MACRO_TAP) release_tap = !release_tap;
    if (!release_tap) ++next_step;
    k_work_reschedule(&play_work, K_MSEC(delay));
}

static int macro_pressed(struct zmk_behavior_binding *binding, struct zmk_behavior_binding_event event) {
    if (binding->param1 >= ZDKM_MACRO_SLOTS || !atomic_cas(&running, 0, 1)) return ZMK_BEHAVIOR_OPAQUE;
    if (zdkm_macro_get(binding->param1, &playing) < 0 || !playing.count ||
        !valid(&playing, true)) {
        atomic_clear(&running);
        return ZMK_BEHAVIOR_OPAQUE;
    }
    trigger = event;
    next_step = 0;
    release_tap = false;
    k_work_reschedule(&play_work, K_NO_WAIT);
    return ZMK_BEHAVIOR_OPAQUE;
}

static int macro_released(struct zmk_behavior_binding *binding, struct zmk_behavior_binding_event event) {
    return ZMK_BEHAVIOR_OPAQUE;
}

static const struct behavior_parameter_value_metadata slots[] = {{
    .display_name = "Macro slot",
    .type = BEHAVIOR_PARAMETER_VALUE_TYPE_RANGE,
    .range = {.min = 0, .max = ZDKM_MACRO_SLOTS - 1},
}};
static const struct behavior_parameter_metadata_set macro_sets[] = {{
    .param1_values_len = ARRAY_SIZE(slots),
    .param1_values = slots,
}};
static const struct behavior_parameter_metadata macro_metadata = {
    .sets_len = ARRAY_SIZE(macro_sets),
    .sets = macro_sets,
};
static const struct behavior_driver_api macro_api = {
    .binding_pressed = macro_pressed,
    .binding_released = macro_released,
    .parameter_metadata = &macro_metadata,
};
BEHAVIOR_DT_INST_DEFINE(0, NULL, NULL, NULL, NULL, POST_KERNEL, CONFIG_KERNEL_INIT_PRIORITY_DEFAULT,
                        &macro_api);
