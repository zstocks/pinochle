// Scoring for a hand of Pinochle.
//
// Two exported functions:
//   scoreHand                — scores a hand that was actually played out
//   scoreDealerNoMarriage    — scores the dealer-auto-take-no-marriage case
//
// Both return { team_A, team_B, declarerSet } where team_A and team_B are
// score *deltas* (not new totals). The caller applies them to existing scores.
// See section 8 of rules.md for the full specification.

const TEAMS = ["team_A", "team_B"];
const MIN_COUNTERS_TO_SAVE = 20;
const MIN_MELD_TO_SAVE = 20;
const TOTAL_COUNTERS_PER_HAND = 50;
const DEALER_NO_MARRIAGE_PENALTY = 50;

/**
 * Score a fully-played hand.
 *
 * Input:
 *   bid          — the winning bid (number)
 *   declarerTeam — "team_A" or "team_B"
 *   meld         — { team_A: number, team_B: number }
 *   counters     — { team_A: number, team_B: number } (must sum to 50)
 *
 * Output:
 *   { team_A: delta, team_B: delta, declarerSet: boolean }
 */
export function scoreHand({ bid, declarerTeam, meld, counters }) {
    if (!TEAMS.includes(declarerTeam)) {
        throw new Error(`declarerTeam must be "team_A" or "team_B", got "${declarerTeam}"`);
    }

    const counterSum = counters.team_A + counters.team_B;
    if (counterSum !== TOTAL_COUNTERS_PER_HAND) {
        throw new Error(
            `counters must sum to ${TOTAL_COUNTERS_PER_HAND}, got ${counterSum}`
        );
    }

    const opponentTeam = declarerTeam === "team_A" ? "team_B" : "team_A";

    const declarerDelta = scoreDeclarer({
        bid,
        meld: meld[declarerTeam],
        counters: counters[declarerTeam]
    });

    const opponentDelta = scoreOpponent({
        meld: meld[opponentTeam],
        counters: counters[opponentTeam]
    });

    return {
        [declarerTeam]: declarerDelta,
        [opponentTeam]: opponentDelta,
        declarerSet: declarerDelta < 0
    };
}

/**
 * Score the dealer-auto-take-no-marriage edge case.
 *
 * The dealing team is set 50 points. The non-dealing team still goes through
 * meld declaration: if their combined meld ≥ 20, they save it. The 20-counter
 * floor doesn't apply here because no tricks are played.
 *
 * Input:
 *   dealerTeam — "team_A" or "team_B"
 *   meld       — { team_A: number, team_B: number }
 */
export function scoreDealerNoMarriage({ dealerTeam, meld }) {
    if (!TEAMS.includes(dealerTeam)) {
        throw new Error(`dealerTeam must be "team_A" or "team_B", got "${dealerTeam}"`);
    }

    const opponentTeam = dealerTeam === "team_A" ? "team_B" : "team_A";
    const opponentMeld = meld[opponentTeam];

    const opponentDelta = opponentMeld >= MIN_MELD_TO_SAVE ? opponentMeld : 0;

    return {
        [dealerTeam]: -DEALER_NO_MARRIAGE_PENALTY,
        [opponentTeam]: opponentDelta,
        declarerSet: true
    };
}

// ----- Internal helpers -------------------------------------------------------
//
// Separating each team's scoring logic into its own helper makes each branch
// short and independently readable. These aren't exported — scoreHand is the
// single public entry point for a played hand.

function scoreDeclarer({ bid, meld, counters }) {
    // Rule 1: must have at least 20 meld.
    if (meld < MIN_MELD_TO_SAVE) {
        return -bid;
    }

    // Rule 2: must pull at least max(20, bid - meld) counters.
    const counterThreshold = Math.max(MIN_COUNTERS_TO_SAVE, bid - meld);
    if (counters < counterThreshold) {
        return -bid;
    }

    // Both requirements met: save meld + earn counters.
    return meld + counters;
}

function scoreOpponent({ meld, counters }) {
    const hasMeldFloor = meld >= MIN_MELD_TO_SAVE;
    const hasCounterFloor = counters >= MIN_COUNTERS_TO_SAVE;

    if (hasMeldFloor && hasCounterFloor) return meld + counters;
    if (!hasMeldFloor && hasCounterFloor) return counters;  // counters only
    return 0;
}