#ifndef ZDKM_RUNTIME_H
#define ZDKM_RUNTIME_H

#include <zdkm/combo.h>

struct zmk_behavior_binding;

enum zdkm_status {
    ZDKM_LOADING,
    ZDKM_ACTIVE,
    ZDKM_PENDING,
    ZDKM_INVALID,
};

enum zdkm_status zdkm_get_status(void);
struct zdkm_combo zdkm_get_combo(size_t slot);
bool zdkm_is_legacy(const struct zdkm_combo *combo);
int zdkm_save(int slot, struct zdkm_combo combo);
size_t zdkm_position_count(void);
size_t zdkm_layer_count(void);
size_t zdkm_slot_count(void);
size_t zdkm_action_count(void);
const char *zdkm_action_at(size_t index, uint16_t *code);
uint32_t zdkm_backup_layout_id(void);
void zdkm_authorize(void);
bool zdkm_keys_held(void);
bool zdkm_supports_extended_keys(void);
uint16_t zdkm_keyboard_usage_limit(void);
uint16_t zdkm_consumer_usage_limit(void);
uint32_t zdkm_key_binding(uint32_t output);
bool zdkm_key_supported(uint32_t output);
unsigned int zdkm_bluetooth_profiles(void);
unsigned int zdkm_output_commands(void);
bool zdkm_is_bluetooth_action(uint32_t output);
bool zdkm_bluetooth_binding(uint32_t output, struct zmk_behavior_binding *binding);

#define ZDKM_PACKED_KEY UINT32_C(0x10000000)
#define ZDKM_KEY_PAYLOAD UINT32_C(0x3fffffff)

#endif
