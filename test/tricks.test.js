import { test } from "node:test";
import assert from "node:assert/strict";
import { legalPlays, trickWinner } from "../src/tricks.js";

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