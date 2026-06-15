// Meld computation for a hand of Pinochle.
//
// One exported function: computeMeld(hand, trump) returns the total meld value
// and a breakdown of which melds were detected. Implements section 6 of rules.md.
//
// The algorithm proceeds in three independent categories that share cards freely:
//   1. Structures: family/double family, round robin, marriages
//   2. Rounds: round of A/K/Q/J (and their doubles)
//   3. Pinochle (single/double/triple)
//
// Within a single category, a card is consumed by at most one meld. Across
// categories, the same card can contribute multiple times (a Q♠ in a trump
// family also contributes to round of queens and to a pinochle).

import { parseCard } from "./cards.js";

const SUITS = ["C", "D", "H", "S"];
const FAMILY_RANKS = ["A", "10", "K", "Q", "J"];

// Each breakdown entry carries the actual cards forming that meld, so callers
// (e.g. the meld calculator UI) can show the card symbols. These build the
// canonical card lists for a detected combo.
function repeat(cards, times) {
    const out = [];
    for (let i = 0; i < times; i++) out.push(...cards);
    return out;
}
function familyCards(trump, tier) {
    return repeat(FAMILY_RANKS.map((r) => r + trump), tier);
}
function rankRoundCards(rank, tier) {
    return repeat(SUITS.map((s) => rank + s), tier);
}
function roundRobinCards() {
    return SUITS.flatMap((s) => ["K" + s, "Q" + s]);
}
function pinochleCards(count) {
    return repeat(["QS", "JD"], count);
}

// Meld point values. Pulled out as constants so the code reads against the spec
// and any future rule tweaks live in one place.
const POINTS = {
    MARRIAGE: 2,
    MARRIAGE_TRUMP: 4,
    ROUND_ROBIN: 24,
    FAMILY: 16,
    DOUBLE_FAMILY: 150,
    ROUND_ACES: 10,
    DOUBLE_ROUND_ACES: 100,
    ROUND_KINGS: 8,
    DOUBLE_ROUND_KINGS: 80,
    ROUND_QUEENS: 6,
    DOUBLE_ROUND_QUEENS: 60,
    ROUND_JACKS: 4,
    DOUBLE_ROUND_JACKS: 40,
    PINOCHLE: 4,
    DOUBLE_PINOCHLE: 30,
    TRIPLE_PINOCHLE: 90
};

// ----- Public API -------------------------------------------------------------

/**
 * Compute meld for a hand given the trump suit.
 *
 * `trump` may be `null` to mean "no trump." This is needed for the dealer-
 * auto-take-no-marriage case (rules.md §5): no trump is ever declared, so the
 * non-dealing team's meld is scored with no trump-dependent bonuses — no family
 * (family is trump-only), and every marriage counts as a plain non-trump
 * marriage (2). Round robin, the A/K/Q/J rounds, and pinochle are unaffected
 * since none of them depend on trump. The existing logic already yields exactly
 * this when no suit equals the trump, so `null` needs no special-casing below.
 *
 * Returns:
 *   {
 *     total: number,
 *     breakdown: [{ name: string, points: number, cards: string[] }, ...]
 *   }
 *
 * The breakdown lists each detected meld separately, with the cards forming it.
 * For example, two non-trump marriages produce two entries of
 * {name: "Marriage (D)", points: 2, cards: ["KD", "QD"]}.
 */
export function computeMeld(hand, trump) {
    if (trump !== null && !SUITS.includes(trump)) {
        throw new Error(`trump must be one of C/D/H/S or null, got "${trump}"`);
    }

    const counts = countCards(hand);
    const breakdown = [];

    addStructures(counts, trump, breakdown);
    addRounds(counts, breakdown);
    addPinochle(counts, breakdown);

    const total = breakdown.reduce((sum, item) => sum + item.points, 0);
    return { total, breakdown };
}

// ----- Card counting ----------------------------------------------------------

function countCards(hand) {
    const counts = {};
    for (const card of hand) {
        counts[card] = (counts[card] || 0) + 1;
    }
    return counts;
}

// How many copies of (rank, suit) appear in the hand?
function copies(counts, rank, suit) {
    return counts[rank + suit] || 0;
}

// ----- Structures: family, round robin, marriages, K/Q rounds ----------------
//
// Round robin and rounds of K/Q are intertwined: round robin's 24 points are
// equivalent to (4 marriages + round of K + round of Q). When round robin
// fires, the single rounds of K and Q are absorbed into it.
//
// However, if a hand qualifies for a *double* round of K or Q, round robin
// can't cleanly "absorb" them — the math would either undercount or
// double-count. The cleanest rule (per house rules): if doubles are present,
// abandon round robin entirely and score piecewise.
//
// So K/Q rounds are scored here, alongside structures. Aces and jacks are
// handled separately in addRounds.

function addStructures(counts, trump, breakdown) {
    const familyTier = detectFamily(counts, trump);  // 0, 1, or 2

    if (familyTier === 2) {
        breakdown.push({ name: "Double Family", points: POINTS.DOUBLE_FAMILY, cards: familyCards(trump, 2) });
    } else if (familyTier === 1) {
        breakdown.push({ name: `Family (${trump})`, points: POINTS.FAMILY, cards: familyCards(trump, 1) });
    }

    // K+Q pairs available in each suit, after family consumption.
    const pairsBySuit = {};
    for (const suit of SUITS) {
        let pairs = Math.min(copies(counts, "K", suit), copies(counts, "Q", suit));
        if (suit === trump) pairs = Math.max(0, pairs - familyTier);
        pairsBySuit[suit] = pairs;
    }

    // Detect doubles of K or Q (based on raw card counts, not pair availability).
    const hasDoubleKingsRound = SUITS.every((s) => copies(counts, "K", s) >= 2);
    const hasDoubleQueensRound = SUITS.every((s) => copies(counts, "Q", s) >= 2);

    // Round robin: marriage in every suit AND no double K-round AND no double Q-round.
    const everySuitHasMarriage = SUITS.every((s) => pairsBySuit[s] >= 1);
    const useRoundRobin = everySuitHasMarriage && !hasDoubleKingsRound && !hasDoubleQueensRound;

    if (useRoundRobin) {
        breakdown.push({ name: "Round Robin", points: POINTS.ROUND_ROBIN, cards: roundRobinCards() });
        // Round robin absorbs 1 marriage from each suit (and the single rounds of K and Q).
        for (const suit of SUITS) pairsBySuit[suit] -= 1;
    } else {
        // Piecewise: K and Q rounds score independently here.
        scoreKAndQRounds(counts, breakdown);
    }

    // Remaining individual marriages.
    for (const suit of SUITS) {
        for (let i = 0; i < pairsBySuit[suit]; i++) {
            if (suit === trump) {
                breakdown.push({
                    name: `Marriage in trump (${suit})`,
                    points: POINTS.MARRIAGE_TRUMP,
                    cards: ["K" + suit, "Q" + suit]
                });
            } else {
                breakdown.push({
                    name: `Marriage (${suit})`,
                    points: POINTS.MARRIAGE,
                    cards: ["K" + suit, "Q" + suit]
                });
            }
        }
    }
}

// Scores the K-round and Q-round (single or double) when round robin doesn't fire.
function scoreKAndQRounds(counts, breakdown) {
    const minKings = Math.min(...SUITS.map((s) => copies(counts, "K", s)));
    if (minKings >= 2) {
        breakdown.push({ name: "Double Round of Kings", points: POINTS.DOUBLE_ROUND_KINGS, cards: rankRoundCards("K", 2) });
    } else if (minKings >= 1) {
        breakdown.push({ name: "Round of Kings", points: POINTS.ROUND_KINGS, cards: rankRoundCards("K", 1) });
    }

    const minQueens = Math.min(...SUITS.map((s) => copies(counts, "Q", s)));
    if (minQueens >= 2) {
        breakdown.push({ name: "Double Round of Queens", points: POINTS.DOUBLE_ROUND_QUEENS, cards: rankRoundCards("Q", 2) });
    } else if (minQueens >= 1) {
        breakdown.push({ name: "Round of Queens", points: POINTS.ROUND_QUEENS, cards: rankRoundCards("Q", 1) });
    }
}

// Returns 0 (no family), 1 (single family), or 2 (double family).
// Family requires A, 10, K, Q, J all in trump suit.
function detectFamily(counts, trump) {
    const minCopies = Math.min(...FAMILY_RANKS.map((r) => copies(counts, r, trump)));
    return Math.min(minCopies, 2);
}

// ----- Rounds (Aces and Jacks only) -------------------------------------------
//
// K and Q rounds are scored in addStructures because they interact with
// round robin. Aces and Jacks have no such interaction — they're standalone.

function addRounds(counts, breakdown) {
    const roundConfig = [
        { rank: "A", single: POINTS.ROUND_ACES,  double: POINTS.DOUBLE_ROUND_ACES,  name: "Aces" },
        { rank: "J", single: POINTS.ROUND_JACKS, double: POINTS.DOUBLE_ROUND_JACKS, name: "Jacks" }
    ];

    for (const { rank, single, double, name } of roundConfig) {
        const minPerSuit = Math.min(...SUITS.map((s) => copies(counts, rank, s)));
        if (minPerSuit >= 2) {
            breakdown.push({ name: `Double Round of ${name}`, points: double, cards: rankRoundCards(rank, 2) });
        } else if (minPerSuit >= 1) {
            breakdown.push({ name: `Round of ${name}`, points: single, cards: rankRoundCards(rank, 1) });
        }
    }
}

// ----- Pinochle ---------------------------------------------------------------
//
// Pinochle is Q♠ + J♦. The number of pinochles is limited by the lesser of
// the two card counts. Triple > Double > Single, never simultaneously.

function addPinochle(counts, breakdown) {
    const pinochleCount = Math.min(copies(counts, "Q", "S"), copies(counts, "J", "D"));
    if (pinochleCount >= 3) {
        breakdown.push({ name: "Triple Pinochle", points: POINTS.TRIPLE_PINOCHLE, cards: pinochleCards(3) });
    } else if (pinochleCount === 2) {
        breakdown.push({ name: "Double Pinochle", points: POINTS.DOUBLE_PINOCHLE, cards: pinochleCards(2) });
    } else if (pinochleCount === 1) {
        breakdown.push({ name: "Pinochle", points: POINTS.PINOCHLE, cards: pinochleCards(1) });
    }
}