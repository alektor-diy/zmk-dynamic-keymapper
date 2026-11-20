#include <zdkm/combo.h>

bool zdkm_add_position(struct zdkm_combo *combo, uint16_t position) {
    if (combo->count == ZDKM_MAX_KEYS) {
        return false;
    }
    size_t index = combo->count;
    while (index && combo->positions[index - 1] > position) {
        --index;
    }
    if (index && combo->positions[index - 1] == position) {
        return false;
    }
    for (size_t i = combo->count; i > index; --i) {
        combo->positions[i] = combo->positions[i - 1];
    }
    combo->positions[index] = position;
    ++combo->count;
    return true;
}

static bool contains_position(const struct zdkm_combo *combo, uint16_t position) {
    for (size_t i = 0; i < combo->count; ++i) {
        if (combo->positions[i] == position) {
            return true;
        }
    }
    return false;
}

bool zdkm_prune(struct zdkm_sequence *sequence, const struct zdkm_combo *combos, size_t slots,
                int64_t timestamp) {
    for (size_t i = 0; i < slots; ++i) {
        if ((sequence->candidates & (UINT64_C(1) << i)) &&
            timestamp >= sequence->started + combos[i].timeout_ms) {
            sequence->candidates &= ~(UINT64_C(1) << i);
        }
    }
    return sequence->candidates != 0;
}

int64_t zdkm_deadline(const struct zdkm_sequence *sequence, const struct zdkm_combo *combos,
                      size_t slots) {
    int64_t deadline = INT64_MAX;
    for (size_t i = 0; i < slots; ++i) {
        int64_t expiry = sequence->started + combos[i].timeout_ms;
        if ((sequence->candidates & (UINT64_C(1) << i)) && expiry < deadline) {
            deadline = expiry;
        }
    }
    return deadline;
}

enum zdkm_match zdkm_press(struct zdkm_sequence *sequence, const struct zdkm_combo *combos,
                           size_t slots, uint16_t position, int64_t timestamp, uint8_t layer,
                           int64_t last_keypress) {
    if (sequence->count == 0) {
        for (size_t i = 0; i < slots; ++i) {
            const struct zdkm_combo *combo = &combos[i];
            bool on_layer = !combo->layers || (layer < 32 && (combo->layers & (1u << layer)));
            if (on_layer && (!combo->prior_idle_ms || timestamp >= last_keypress + combo->prior_idle_ms) &&
                contains_position(combo, position)) {
                sequence->candidates |= UINT64_C(1) << i;
            }
        }
        if (!sequence->candidates) {
            return ZDKM_PASS;
        }
        sequence->started = timestamp;
    } else {
        zdkm_prune(sequence, combos, slots, timestamp);
    }

    ++sequence->count;
    for (size_t i = 0; i < slots; ++i) {
        if ((sequence->candidates & (UINT64_C(1) << i)) && !contains_position(&combos[i], position)) {
            sequence->candidates &= ~(UINT64_C(1) << i);
        }
    }
    if (!sequence->candidates) {
        return ZDKM_RESOLVE;
    }
    for (size_t i = 0; i < slots; ++i) {
        if ((sequence->candidates & (UINT64_C(1) << i)) && combos[i].count == sequence->count) {
            sequence->completed = i + 1;
            /* A complete shorter combo remains a fallback while a longer candidate is live. */
            if ((sequence->candidates & (sequence->candidates - 1)) == 0) {
                return ZDKM_RESOLVE;
            }
            break;
        }
    }
    return ZDKM_WAIT;
}

enum zdkm_release zdkm_release_key(const struct zdkm_combo *combo, uint32_t *held,
                                   uint16_t position) {
    for (size_t i = 0; i < combo->count; ++i) {
        uint32_t bit = 1u << i;
        if (combo->positions[i] != position || !(*held & bit)) {
            continue;
        }
        bool first = *held == (1u << combo->count) - 1;
        *held &= ~bit;
        return (combo->slow_release ? !*held : first) ? ZDKM_RELEASE_OUTPUT : ZDKM_CONSUMED_RELEASE;
    }
    return ZDKM_NOT_HELD;
}

