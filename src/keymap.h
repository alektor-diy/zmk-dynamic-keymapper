#ifndef ZDKM_KEYMAP_H
#define ZDKM_KEYMAP_H

#include <drivers/behavior.h>

size_t zdkm_behavior_count(void);
const struct zmk_behavior_ref *zdkm_behavior_at(size_t index);
int zdkm_set_binding(uint8_t layer, uint8_t position, const struct zmk_behavior_binding *binding);

#endif
