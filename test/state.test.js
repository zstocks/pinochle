import { test } from "node:test";
import assert from "node:assert/strict";
import {
    teamOf,
    partnerOf,
    nextSeat,
    createInitialState,
    dealHand
} from "../src/state.js";

// ----- Seat/team helpers ------------------------------------------------------

test("teamOf assigns even seats to team_A, odd to team_B", () => {
    assert.strictEqual(teamOf(0), "team_A");
    assert.strictEqual(teamOf(2), "team_A");
    assert.strictEqual(teamOf(1), "team_B");
    assert.strictEqual(teamOf(3), "team_B");
});

test("partnerOf returns the seat across the table", () => {
    assert.strictEqual(partnerOf(0), 2);
    assert.strictEqual(partnerOf(2), 0);
    assert.strictEqual(partnerOf(1), 3);
    assert.strictEqual(partnerOf(3), 1);
});

test("nextSeat advances clockwise and wraps", () => {
    assert.strictEqual(nextSeat(0), 1);
    assert.strictEqual(nextSeat(1), 2);
    assert.strictEqual(nextSeat(2), 3);
    assert.strictEqual(nextSeat(3), 0);
});

// ----- createInitialState -----------------------------------------------------

test("createInitialState builds a fresh game state", () => {
    const state = createInitialState(["Alice", "Bob", "Carol", "Dave"]);

    assert.strictEqual(state.phase, "dealing");
    assert.strictEqual(state.seats.length, 4);
    assert.deepEqual(state.seats.map((s) => s.name), ["Alice", "Bob", "Carol", "Dave"]);
    assert.deepEqual(state.seats.map((s) => s.hand), [[], [], [], []]);

    assert.ok(state.dealer >= 0 && state.dealer <= 3);
    assert.strictEqual(state.currentPlayer, null);

    assert.deepEqual(state.scores, { team_A: 0, team_B: 0 });
    assert.strictEqual(state.targetScore, 500);

    assert.deepEqual(state.bidding.passed, [false, false, false, false]);
    assert.strictEqual(state.bidding.trump, null);

    assert.deepEqual(state.meld.declared, [null, null, null, null]);
    assert.deepEqual(state.tricks.currentTrick, []);
});

test("createInitialState throws on wrong number of players", () => {
    assert.throws(() => createInitialState(["A", "B", "C"]), /exactly 4/);
    assert.throws(() => createInitialState(["A", "B", "C", "D", "E"]), /exactly 4/);
    assert.throws(() => createInitialState([]), /exactly 4/);
    assert.throws(() => createInitialState(null), /exactly 4/);
    assert.throws(() => createInitialState("not an array"), /exactly 4/);
});

// ----- dealHand ---------------------------------------------------------------

test("dealHand gives each seat 20 cards", () => {
    const before = createInitialState(["A", "B", "C", "D"]);
    const after = dealHand(before);

    for (const seat of after.seats) {
        assert.strictEqual(seat.hand.length, 20);
    }
});

test("dealHand distributes all 80 cards correctly", () => {
    const before = createInitialState(["A", "B", "C", "D"]);
    const after = dealHand(before);

    const allCards = after.seats.flatMap((s) => s.hand);
    assert.strictEqual(allCards.length, 80);

    // Every card should appear exactly 4 times across all hands.
    const counts = {};
    for (const card of allCards) {
        counts[card] = (counts[card] || 0) + 1;
    }
    assert.strictEqual(Object.keys(counts).length, 20);
    for (const count of Object.values(counts)) {
        assert.strictEqual(count, 4);
    }
});

test("dealHand transitions phase to bidding", () => {
    const before = createInitialState(["A", "B", "C", "D"]);
    const after = dealHand(before);
    assert.strictEqual(after.phase, "bidding");
});

test("dealHand sets currentPlayer to the seat left of the dealer", () => {
    const before = createInitialState(["A", "B", "C", "D"]);
    const after = dealHand(before);
    assert.strictEqual(after.currentPlayer, nextSeat(before.dealer));
});

test("dealHand does not mutate the input state", () => {
    const before = createInitialState(["A", "B", "C", "D"]);
    const snapshot = JSON.stringify(before);
    dealHand(before);
    assert.strictEqual(JSON.stringify(before), snapshot);
});

test("dealHand throws if state is not in dealing phase", () => {
    const state = createInitialState(["A", "B", "C", "D"]);
    const dealt = dealHand(state);  // now in "bidding"
    assert.throws(() => dealHand(dealt), /phase "dealing"/);
});