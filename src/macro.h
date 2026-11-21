#ifndef ZDKM_MACRO_H
#define ZDKM_MACRO_H

#include <stdint.h>

#define ZDKM_MACRO_SLOTS 8
#define ZDKM_MACRO_STEPS 16
#define ZDKM_MACRO_MAX_WAIT 5000

enum zdkm_macro_op { ZDKM_MACRO_TAP, ZDKM_MACRO_PRESS, ZDKM_MACRO_RELEASE, ZDKM_MACRO_WAIT };

struct zdkm_macro {
    uint8_t count;
    uint32_t steps[ZDKM_MACRO_STEPS];
};

int zdkm_macro_get(uint8_t slot, struct zdkm_macro *macro);
int zdkm_macro_save(uint8_t slot, const struct zdkm_macro *macro);

#endif
