import { test } from "node:test";
import assert from "node:assert/strict";
import { legalPlays, trickWinner, canClaimRemaining } from "../src/tricks.js";

// canClaimRemaining
const seatsWith = (hands) => hands.map((hand) => ({ hand }));

test("canClaimRemaining: leader holds only trump and no one else has trump", () => {
    const seats = seatsWith([["AS", "KS"], ["AH", "10D"], ["AC", "KC"], ["10H", "JD"]]);
    assert.strictEqual(canClaimRemaining(seats, 0, "S"), true);
});

test("canClaimRemaining: false when an opponent still holds trump", () => {
    const seats = seatsWith([["AS", "KS"], ["QS", "10D"], ["AC", "KC"], ["10H", "JD"]]);
    assert.strictEqual(canClaimRemaining(seats, 0, "S"), false);
});

test("canClaimRemaining: false when the leader holds a non-trump card", () => {
    const seats = seatsWith([["AS", "KH"], ["AH", "10D"], ["AC", "KC"], ["10H", "JD"]]);
    assert.strictEqual(canClaimRemaining(seats, 0, "S"), false);
});

test("canClaimRemaining: false with an empty hand", () => {
    const seats = seatsWith([[], [], [], []]);
    assert.strictEqual(canClaimRemaining(seats, 0, "S"), false);
});

test("canClaimRemaining: false on the last trick (one card left)", () => {
    // Even with all-trump and no opponent trump, the final trick can't be claimed.
    const seats = seatsWith([["AS"], ["AH"], ["AD"], ["AC"]]);
    assert.strictEqual(canClaimRemaining(seats, 0, "S"), false);
});

// legalPlays
test("leading a trick — any card is legal", () => {
    const hand = ["AS", "KS", "QS", "JS"];
    const currentTrick = [];
    const trump = "H";
    const result = legalPlays(hand, currentTrick, trump);
    assert.deepStrictEqual(result, hand);
});

test("can follow suit — only beaters are legal", () => {
    const hand = ["AS", "QS", "JH"];
    const currentTrick = [{ seat: 0, card: "KS" }];
    const trump = "H";
    assert.deepStrictEqual(legalPlays(hand, currentTrick, trump), ["AS"]);
});

test("can follow suit — no beaters means all led-suit cards are legal", () => {
    const hand = ["KS", "QS", "JH"];
    const currentTrick = [{ seat: 0, card: "AS" }];
    const trump = "H";
    assert.deepStrictEqual(legalPlays(hand, currentTrick, trump), ["KS", "QS"]);
});

test("over-trump required when you can", () => {
    const hand = ["AH", "KH", "QH", "JH"];
    const currentTrick = [{ seat: 0, card: "AS" }, { seat: 1, card: "KH" }];
    const trump = "H";
    const result = legalPlays(hand, currentTrick, trump);
    assert.deepStrictEqual(result, ["AH"]);
});

test("void in led suit, holding trump that can't beat the winning trump — any trump is legal", () => {
    // The reported lock-up: clubs trump, diamonds led, opponent trumped with 10C.
    // Player is void in diamonds and holds only jacks of trump (all below the 10),
    // so they can't over-trump — every jack must be a legal play, not none.
    const hand = ["JC", "JC", "JC"];
    const currentTrick = [{ seat: 0, card: "10D" }, { seat: 1, card: "10C" }];
    const result = legalPlays(hand, currentTrick, "C");
    assert.deepStrictEqual(result, ["JC", "JC", "JC"]);
});

test("void in led suit, can over-trump the winning trump — must beat it", () => {
    const hand = ["AC", "JC"];   // AC beats 10C; JC does not
    const currentTrick = [{ seat: 0, card: "10D" }, { seat: 1, card: "10C" }];
    assert.deepStrictEqual(legalPlays(hand, currentTrick, "C"), ["AC"]);
});

// trickWinner
test("highest trump wins; tie goes to first-played", () => {
    const trick = [
        { seat: 0, card: "AH" },
        { seat: 1, card: "KH" },
        { seat: 2, card: "QH" },
        { seat: 3, card: "JH" }
    ];
    const trump = "H";
    const result = trickWinner(trick, trump);
    assert.strictEqual(result, 0);
});