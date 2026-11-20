#include <assert.h>

#include <zdkm/combo.h>

static const struct zdkm_combo combos[] = {
    {.positions = {0, 1}, .count = 2, .timeout_ms = 50},
    {.positions = {0, 1, 2}, .count = 3, .timeout_ms = 80},
    {.positions = {0, 3}, .count = 2, .timeout_ms = 30},
    {.positions = {4, 5}, .count = 2, .timeout_ms = 50, .layers = 1u << 2, .prior_idle_ms = 100},
};
static struct zdkm_sequence sequence;

static enum zdkm_match press(uint16_t position, int64_t timestamp) {
    return zdkm_press(&sequence, combos, 4, position, timestamp, 0, -10000);
}

static void overlap_prefers_larger(void) {
    assert(press(1, 100) == ZDKM_WAIT);
    assert(press(0, 120) == ZDKM_WAIT && sequence.completed == 1);
    assert(zdkm_deadline(&sequence, combos, 4) == 150);
    assert(zdkm_prune(&sequence, combos, 4, 150));
    assert(zdkm_deadline(&sequence, combos, 4) == 180);
    assert(press(2, 179) == ZDKM_RESOLVE && sequence.completed == 2);
}

static void shorter_fallback_and_incomplete(void) {
    assert(press(0, 200) == ZDKM_WAIT);
    assert(press(1, 210) == ZDKM_WAIT);
    assert(press(2, 280) == ZDKM_RESOLVE && sequence.completed == 1);
    sequence = (struct zdkm_sequence){0};
    assert(press(0, 300) == ZDKM_WAIT);
    assert(press(2, 310) == ZDKM_WAIT && !sequence.completed);
    assert(press(9, 320) == ZDKM_RESOLVE && !sequence.completed);
}

static void partial_overlap_filters(void) {
    assert(press(0, 400) == ZDKM_WAIT);
    assert(zdkm_deadline(&sequence, combos, 4) == 430);
    assert(press(3, 429) == ZDKM_RESOLVE && sequence.completed == 3);
    sequence = (struct zdkm_sequence){0};
    assert(press(0, 500) == ZDKM_WAIT);
    assert(press(3, 530) == ZDKM_RESOLVE && !sequence.completed);
}

static void layers_and_idle(void) {
    assert(zdkm_press(&sequence, combos, 4, 4, 200, 1, 0) == ZDKM_PASS);
    assert(zdkm_press(&sequence, combos, 4, 4, 200, 2, 101) == ZDKM_PASS);
    assert(zdkm_press(&sequence, combos, 4, 4, 200, 2, 100) == ZDKM_WAIT);
    /* Eligibility is checked at the start, as in ZMK. */
    assert(zdkm_press(&sequence, combos, 4, 5, 210, 0, 205) == ZDKM_RESOLVE);
    assert(sequence.completed == 4);
}

static void maximum_length(void) {
    struct zdkm_combo combo = {.count = ZDKM_MAX_KEYS, .timeout_ms = 50};
    for (uint16_t i = 0; i < ZDKM_MAX_KEYS; ++i) combo.positions[i] = i;
    for (uint16_t i = ZDKM_MAX_KEYS; i > 1; --i) {
        assert(zdkm_press(&sequence, &combo, 1, i - 1, 100 + ZDKM_MAX_KEYS - i, 0, 0) == ZDKM_WAIT);
    }
    assert(zdkm_press(&sequence, &combo, 1, 0, 120, 0, 0) == ZDKM_RESOLVE);
    assert(sequence.completed == 1);
}

static void release_modes(void) {
    struct zdkm_combo combo = {.positions = {0, 1, 2}, .count = 3};
    uint32_t held = 7;
    assert(zdkm_release_key(&combo, &held, 1) == ZDKM_RELEASE_OUTPUT);
    assert(zdkm_release_key(&combo, &held, 1) == ZDKM_NOT_HELD);
    assert(zdkm_release_key(&combo, &held, 2) == ZDKM_CONSUMED_RELEASE);
    assert(zdkm_release_key(&combo, &held, 0) == ZDKM_CONSUMED_RELEASE);
    assert(held == 0);

    combo.slow_release = true;
    held = 7;
    assert(zdkm_release_key(&combo, &held, 1) == ZDKM_CONSUMED_RELEASE);
    assert(zdkm_release_key(&combo, &held, 0) == ZDKM_CONSUMED_RELEASE);
    assert(zdkm_release_key(&combo, &held, 2) == ZDKM_RELEASE_OUTPUT);
    assert(held == 0);
}

static void imported_positions_and_high_slots(void) {
    struct zdkm_combo table[ZDKM_MAX_COMBOS] = {0};
    struct zdkm_combo *combo = &table[ZDKM_MAX_COMBOS - 1];
    combo->timeout_ms = 50;
    assert(zdkm_add_position(combo, 15));
    assert(zdkm_add_position(combo, 1));
    assert(zdkm_add_position(combo, 5));
    assert(!zdkm_add_position(combo, 5));
    assert(combo->count == 3 && combo->positions[0] == 1 && combo->positions[2] == 15);

    struct zdkm_sequence imported = {0};
    assert(zdkm_press(&imported, table, ZDKM_MAX_COMBOS, 15, 10, 0, 0) == ZDKM_WAIT);
    assert(zdkm_press(&imported, table, ZDKM_MAX_COMBOS, 1, 20, 0, 0) == ZDKM_WAIT);
    assert(zdkm_press(&imported, table, ZDKM_MAX_COMBOS, 5, 30, 0, 0) == ZDKM_RESOLVE);
    assert(imported.completed == ZDKM_MAX_COMBOS);
}

int main(void) {
    assert(press(9, 0) == ZDKM_PASS);
    overlap_prefers_larger();
    sequence = (struct zdkm_sequence){0};
    shorter_fallback_and_incomplete();
    sequence = (struct zdkm_sequence){0};
    partial_overlap_filters();
    sequence = (struct zdkm_sequence){0};
    layers_and_idle();
    sequence = (struct zdkm_sequence){0};
    maximum_length();
    release_modes();
    imported_positions_and_high_slots();
    return 0;
}

