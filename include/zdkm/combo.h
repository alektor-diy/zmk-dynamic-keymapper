#ifndef ZDKM_COMBO_H
#define ZDKM_COMBO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define ZDKM_MAX_KEYS 20
#define ZDKM_MAX_COMBOS 64

struct zdkm_combo {
    uint32_t layers;
    uint32_t output;
    uint16_t positions[ZDKM_MAX_KEYS];
    uint16_t timeout_ms;
    uint16_t prior_idle_ms;
    uint8_t count;
    bool slow_release;
};

struct zdkm_sequence {
    int64_t started;
    uint64_t candidates;
    uint8_t count;
    uint8_t completed; /* Slot plus one; zero means no match. */
};

enum zdkm_match { ZDKM_PASS, ZDKM_WAIT, ZDKM_RESOLVE };
enum zdkm_release { ZDKM_NOT_HELD, ZDKM_CONSUMED_RELEASE, ZDKM_RELEASE_OUTPUT };

bool zdkm_add_position(struct zdkm_combo *combo, uint16_t position);
enum zdkm_match zdkm_press(struct zdkm_sequence *sequence, const struct zdkm_combo *combos,
                           size_t slots, uint16_t position, int64_t timestamp, uint8_t layer,
                           int64_t last_keypress);
bool zdkm_prune(struct zdkm_sequence *sequence, const struct zdkm_combo *combos, size_t slots,
                int64_t timestamp);
int64_t zdkm_deadline(const struct zdkm_sequence *sequence, const struct zdkm_combo *combos,
                      size_t slots);
enum zdkm_release zdkm_release_key(const struct zdkm_combo *combo, uint32_t *held,
                                   uint16_t position);

#endif

