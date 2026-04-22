import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreHand, scoreDealerNoMarriage } from "../src/scoring.js";

// ----- scoreHand: declarer outcomes -------------------------------------------

test("declarer wins cleanly when meld + counters cover the bid", () => {
    // Bid 60, meld 40, counters 30. Needs max(20, 60-40) = 20. Has 30.
    // Saves meld + counters = 70. Opponents: meld 0, counters 20 → 20.
    const result = scoreHand({
        bid: 60,
        declarerTeam: "team_A",
        meld: { team_A: 40, team_B: 0 },
        counters: { team_A: 30, team_B: 20 }
    });
    assert.deepEqual(result, { team_A: 70, team_B: 20, declarerSet: false });
});

test("declarer set by meld floor (meld < 20)", () => {
    // Bid 50, meld 15 → automatic set regardless of counters.
    const result = scoreHand({
        bid: 50,
        declarerTeam: "team_A",
        meld: { team_A: 15, team_B: 20 },
        counters: { team_A: 40, team_B: 10 }
    });
    assert.strictEqual(result.team_A, -50);
    assert.strictEqual(result.declarerSet, true);
});

test("declarer set by counter shortfall", () => {
    // Bid 80, meld 30. Needs max(20, 50) = 50 counters. Has 40. Set, -80.
    const result = scoreHand({
        bid: 80,
        declarerTeam: "team_B",
        meld: { team_A: 0, team_B: 30 },
        counters: { team_A: 10, team_B: 40 }
    });
    assert.strictEqual(result.team_B, -80);
    assert.strictEqual(result.declarerSet, true);
});

test("declarer meets 20-counter floor when bid is below meld", () => {
    // Bid 50, meld 60. Needs max(20, -10) = 20 counters. Has 20 exactly.
    // Saves 60 + 20 = 80.
    const result = scoreHand({
        bid: 50,
        declarerTeam: "team_A",
        meld: { team_A: 60, team_B: 0 },
        counters: { team_A: 20, team_B: 30 }
    });
    assert.strictEqual(result.team_A, 80);
    assert.strictEqual(result.declarerSet, false);
});

test("declarer set when bid is below meld but counters below 20", () => {
    // Bid 50, meld 60, counters 19. max(20, -10) = 20 required. Falls short.
    // The 20-counter floor applies even when bid <= meld.
    const result = scoreHand({
        bid: 50,
        declarerTeam: "team_A",
        meld: { team_A: 60, team_B: 0 },
        counters: { team_A: 19, team_B: 31 }
    });
    assert.strictEqual(result.team_A, -50);
    assert.strictEqual(result.declarerSet, true);
});

// ----- scoreHand: opponent outcomes -------------------------------------------

test("opponent saves meld and counters when both floors met", () => {
    const result = scoreHand({
        bid: 60,
        declarerTeam: "team_A",
        meld: { team_A: 40, team_B: 30 },
        counters: { team_A: 25, team_B: 25 }
    });
    assert.strictEqual(result.team_B, 55);
});

test("opponent gets counters only when meld below floor", () => {
    // Opponent meld 10 (<20), counters 25 (≥20) → gets 25.
    const result = scoreHand({
        bid: 60,
        declarerTeam: "team_A",
        meld: { team_A: 40, team_B: 10 },
        counters: { team_A: 25, team_B: 25 }
    });
    assert.strictEqual(result.team_B, 25);
});

test("opponent gets nothing when meld ≥ 20 but counters < 20", () => {
    // Has meld but didn't pull enough counters — loses the meld too.
    const result = scoreHand({
        bid: 80,
        declarerTeam: "team_A",
        meld: { team_A: 40, team_B: 30 },
        counters: { team_A: 40, team_B: 10 }
    });
    assert.strictEqual(result.team_B, 0);
});

test("opponent gets nothing when meld < 20 and counters < 20", () => {
    const result = scoreHand({
        bid: 80,
        declarerTeam: "team_A",
        meld: { team_A: 40, team_B: 5 },
        counters: { team_A: 45, team_B: 5 }
    });
    assert.strictEqual(result.team_B, 0);
});

// ----- scoreHand: validation --------------------------------------------------

test("scoreHand throws when counters don't sum to 50", () => {
    assert.throws(
        () => scoreHand({
            bid: 50,
            declarerTeam: "team_A",
            meld: { team_A: 20, team_B: 20 },
            counters: { team_A: 20, team_B: 20 }  // sums to 40
        }),
        /counters must sum to 50/
    );
});

test("scoreHand throws on invalid declarerTeam", () => {
    assert.throws(
        () => scoreHand({
            bid: 50,
            declarerTeam: "team_C",
            meld: { team_A: 20, team_B: 20 },
            counters: { team_A: 25, team_B: 25 }
        }),
        /declarerTeam/
    );
});

// ----- scoreDealerNoMarriage --------------------------------------------------

test("scoreDealerNoMarriage applies -50 to dealer team only", () => {
    assert.deepEqual(
        scoreDealerNoMarriage("team_A"),
        { team_A: -50, team_B: 0, declarerSet: true }
    );
    assert.deepEqual(
        scoreDealerNoMarriage("team_B"),
        { team_A: 0, team_B: -50, declarerSet: true }
    );
});

test("scoreDealerNoMarriage throws on invalid dealer team", () => {
    assert.throws(() => scoreDealerNoMarriage("nope"), /dealerTeam/);
});