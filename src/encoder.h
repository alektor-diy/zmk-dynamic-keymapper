#ifndef ZDKM_ENCODER_H
#define ZDKM_ENCODER_H

#include <stdint.h>

struct zdkm_encoder_codes {
    uint32_t clockwise;
    uint32_t counterclockwise;
};

unsigned int zdkm_encoder_count(void);
int zdkm_encoder_get(uint8_t layer, uint8_t index, struct zdkm_encoder_codes *codes);
int zdkm_encoder_check(uint8_t layer, uint8_t index, const struct zdkm_encoder_codes *codes);
int zdkm_encoder_save(uint8_t layer, uint8_t index, const struct zdkm_encoder_codes *codes);

#endif
