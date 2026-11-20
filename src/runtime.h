#ifndef ZDKM_RUNTIME_H
#define ZDKM_RUNTIME_H

#include <zdkm/combo.h>

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
void zdkm_authorize(void);

#endif
