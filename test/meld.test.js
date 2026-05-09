import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMeld } from "../src/meld.js";

// Helper for tests: expand a list of [card, count] tuples into a flat hand.
function makeHand(cards) {
    const result = [];
    for (const [card, count] of cards) {
        for (let i = 0; i < count; i++) result.push(card);
    }
    return result;
}

// ----- Empty/trivial ----------------------------------------------------------

test("empty hand has no meld", () => {
    const result = computeMeld([], "S");
    assert.strictEqual(result.total, 0);
    assert.deepEqual(result.breakdown, []);
});

test("hand with no meld returns 0", () => {
    // Random cards that form no marriages, families, rounds, or pinochles.
    const hand = ["AC", "10D", "KH", "JS", "JC", "10H"];
    const result = computeMeld(hand, "S");
    assert.strictEqual(result.total, 0);
});

// ----- Marriages --------------------------------------------------------------

test("single marriage in trump", () => {
    const hand = ["KS", "QS", "JC", "10D"];
    const result = computeMeld(hand, "S");
    assert.strictEqual(result.total, 4);
});

test("single marriage in non-trump", () => {
    const hand = ["KH", "QH", "JC", "10D"];
    const result = computeMeld(hand, "S");
    assert.strictEqual(result.total, 2);
});

test("two marriages in different non-trump suits", () => {
    const hand = ["KH", "QH", "KD", "QD"];
    const result = computeMeld(hand, "S");
    assert.strictEqual(result.total, 4);
});

test("two marriages of same trump suit (no family)", () => {
    const hand = makeHand([["KS", 2], ["QS", 2]]);
    const result = computeMeld(hand, "S");
    assert.strictEqual(result.total, 8);  // 4 + 4
});

// ----- Family -----------------------------------------------------------------

test("single family in trump", () => {
    const hand = ["AS", "10S", "KS", "QS", "JS"];
    const result = computeMeld(hand, "S");
    assert.strictEqual(result.total, 16);
});

test("family in trump with extra K+Q of trump = family + extra trump marriage", () => {
    const hand = ["AS", "10S", "KS", "QS", "JS", "KS", "QS"];
    const result = computeMeld(hand, "S");
    // Family (16) + one additional trump marriage (4) = 20
    assert.strictEqual(result.total, 20);
});

test("almost-family (missing the 10) has no family bonus", () => {
    const hand = ["AS", "KS", "QS", "JS"];
    const result = computeMeld(hand, "S");
    // Just the trump marriage K+Q = 4
    assert.strictEqual(result.total, 4);
});

test("family-shaped hand in non-trump scores only as marriage", () => {
    const hand = ["AH", "10H", "KH", "QH", "JH"];
    const result = computeMeld(hand, "S");
    // Just the marriage (non-trump) = 2. No "family" bonus for non-trump.
    assert.strictEqual(result.total, 2);
});

test("double family in trump", () => {
    const hand = makeHand([["AS", 2], ["10S", 2], ["KS", 2], ["QS", 2], ["JS", 2]]);
    const result = computeMeld(hand, "S");
    // 150 flat — not 150 + 16 + 16, not 16 + 16, etc.
    assert.strictEqual(result.total, 150);
});

// ----- Round robin ------------------------------------------------------------

test("round robin with one marriage per suit", () => {
    const hand = ["KC", "QC", "KD", "QD", "KH", "QH", "KS", "QS"];
    const result = computeMeld(hand, "S");
    // Round robin (24) absorbs the 4 marriages, the round of kings, and the
    // round of queens. Nothing else applies. Total = 24.
    assert.strictEqual(result.total, 24);
});

test("round robin plus extra trump marriage", () => {
    // Marriage in C, D, H + double marriage in S (trump)
    const hand = makeHand([["KC", 1], ["QC", 1], ["KD", 1], ["QD", 1],
                           ["KH", 1], ["QH", 1], ["KS", 2], ["QS", 2]]);
    const result = computeMeld(hand, "S");
    // Round robin (24) + extra trump marriage (4) = 28.
    // Single rounds of K and Q are absorbed by round robin. No double rounds
    // exist (only S has 2 of each), so round robin still applies.
    assert.strictEqual(result.total, 28);
});

test("round robin abandoned when a double round of kings is present", () => {
    // 2 K and 1 Q in every suit. Double round of kings exists, so round robin
    // is abandoned and we score piecewise.
    const hand = [
        "KC", "KC", "QC",
        "KD", "KD", "QD",
        "KH", "KH", "QH",
        "KS", "KS", "QS"
    ];
    const result = computeMeld(hand, "S");
    // 4 marriages: 2+2+2+4 = 10
    // Double round of kings: 80
    // Round of queens: 6
    // Total: 96
    assert.strictEqual(result.total, 96);
});

test("round robin abandoned when both double rounds are present", () => {
    // 2 K and 2 Q in every suit.
    const hand = makeHand([
        ["KC", 2], ["QC", 2], ["KD", 2], ["QD", 2],
        ["KH", 2], ["QH", 2], ["KS", 2], ["QS", 2]
    ]);
    const result = computeMeld(hand, "S");
    // 8 marriages: 2+2+2+4 + 2+2+2+4 = 20
    // Double round of kings: 80
    // Double round of queens: 60
    // Total: 160
    assert.strictEqual(result.total, 160);
});

test("three marriages, missing one suit, is NOT round robin", () => {
    const hand = ["KC", "QC", "KD", "QD", "KH", "QH"];
    const result = computeMeld(hand, "S");
    // Three non-trump marriages = 6, no round robin
    assert.strictEqual(result.total, 6);
});

// ----- Rounds -----------------------------------------------------------------

test("round of aces", () => {
    const hand = ["AC", "AD", "AH", "AS"];
    const result = computeMeld(hand, "C");  // trump shouldn't matter for round
    assert.strictEqual(result.total, 10);
});

test("double round of aces", () => {
    const hand = makeHand([["AC", 2], ["AD", 2], ["AH", 2], ["AS", 2]]);
    const result = computeMeld(hand, "C");
    assert.strictEqual(result.total, 100);
});

test("round of jacks", () => {
    const hand = ["JC", "JD", "JH", "JS"];
    const result = computeMeld(hand, "C");
    assert.strictEqual(result.total, 4);
});

test("incomplete round (missing one suit) scores nothing for the round", () => {
    const hand = ["AC", "AD", "AH"];
    const result = computeMeld(hand, "S");
    assert.strictEqual(result.total, 0);
});

// ----- Pinochle ---------------------------------------------------------------

test("single pinochle", () => {
    const hand = ["QS", "JD"];
    const result = computeMeld(hand, "C");
    assert.strictEqual(result.total, 4);
});

test("double pinochle is 30 (not 8 or 16)", () => {
    const hand = makeHand([["QS", 2], ["JD", 2]]);
    const result = computeMeld(hand, "C");
    assert.strictEqual(result.total, 30);
});

test("triple pinochle is 90", () => {
    const hand = makeHand([["QS", 3], ["JD", 3]]);
    const result = computeMeld(hand, "C");
    assert.strictEqual(result.total, 90);
});

test("Q♠ alone (no J♦) is no pinochle", () => {
    const hand = ["QS", "QS"];
    const result = computeMeld(hand, "C");
    assert.strictEqual(result.total, 0);
});

// ----- Cross-category combinations --------------------------------------------

test("family in spades trump + pinochle (Q♠ counts in both)", () => {
    // Family: AS, 10S, KS, QS, JS — uses one Q♠
    // Pinochle needs Q♠ + J♦ — Q♠ counts in both categories
    const hand = ["AS", "10S", "KS", "QS", "JS", "JD"];
    const result = computeMeld(hand, "S");
    // Family (16) + Pinochle (4) = 20
    assert.strictEqual(result.total, 20);
});

test("family in trump + round of queens (Q♠ counts in both)", () => {
    // Q♠ is in family AND in round of queens
    const hand = ["AS", "10S", "KS", "QS", "JS", "QC", "QD", "QH"];
    const result = computeMeld(hand, "S");
    // Family (16) + Round of Queens (6) = 22
    assert.strictEqual(result.total, 22);
});

test("kitchen sink: family + extra marriage + rounds + pinochle", () => {
    // Trump = spades.
    // Family: A, 10, K, Q, J of S
    // Plus extra K, Q of S (extra trump marriage)
    // Plus K, Q of every other suit (with family's K+Q in S, gives round robin)
    // Plus J of D (pinochle with one of the QS)
    // Plus J of C, J of H (round of jacks with JS, JD already present)
    const hand = [
        "AS", "10S", "KS", "QS", "JS",         // family in spades
        "KS", "QS",                            // extra trump K+Q
        "KC", "QC", "KD", "QD", "KH", "QH",   // marriages C, D, H
        "JD",                                   // pinochle with QS
        "JC", "JH"                             // jacks (already have JS, JD)
    ];
    const result = computeMeld(hand, "S");
    // Family (16) consumes 1 trump pair, leaving 1 trump pair.
    // No double rounds of K or Q (each suit has only 1 of each except S which has 2).
    // Wait — S has 2 Ks and 2 Qs, but C/D/H have only 1 each, so minPerSuit = 1.
    // Round robin applies (1+ marriage in every suit after family) → 24,
    // absorbs single rounds of K and Q. Consumes 1 pair from each suit.
    // No remaining marriages.
    // Round of jacks: JC, JD, JH, JS all present → 4
    // Pinochle: min(QS=2, JD=1) = 1 → 4
    // Total: 16 + 24 + 4 + 4 = 48
    assert.strictEqual(result.total, 48);
});

// ----- Validation -------------------------------------------------------------

test("computeMeld throws on invalid trump", () => {
    assert.throws(() => computeMeld([], "X"), /trump must be/);
    assert.throws(() => computeMeld([], ""), /trump must be/);
});

// ----- Breakdown structure ----------------------------------------------------

test("breakdown reflects detected melds with correct totals", () => {
    const hand = ["AS", "10S", "KS", "QS", "JS", "JD"];
    const result = computeMeld(hand, "S");

    assert.strictEqual(result.total, 20);
    assert.strictEqual(result.breakdown.length, 2);

    const sumOfBreakdown = result.breakdown.reduce((s, x) => s + x.points, 0);
    assert.strictEqual(sumOfBreakdown, result.total);

    // Just check that names mention what we expect — exact text isn't critical
    const names = result.breakdown.map((x) => x.name).join(" ");
    assert.match(names, /Family/);
    assert.match(names, /Pinochle/);
});