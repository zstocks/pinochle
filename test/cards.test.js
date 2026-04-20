import { parseCard, isCounter, cardString, rankValue, makeDeck, shuffle } from "../src/cards.js";
import { test } from "node:test";
import assert from "node:assert/strict";

test("parseCard handles single-char ranks", () => {
  assert.deepEqual(parseCard("10S"), { rank: "10", suit: "S" });
  assert.deepEqual(parseCard("AH"), { rank: "A", suit: "H" });
  assert.deepEqual(parseCard("JC"), { rank: "J", suit: "C" });
});

test("isCounter identifies counters correctly", () => {
  assert.strictEqual(isCounter("KS"), true);
  assert.strictEqual(isCounter("10D"), true);
  assert.strictEqual(isCounter("AH"), true);
  assert.strictEqual(isCounter("JC"), false);
  assert.strictEqual(isCounter("QS"), false);
});

test("cardString reassembles a card", () => {
  assert.strictEqual(cardString({ rank: "10", suit: "S" }), "10S");
  assert.strictEqual(cardString({ rank: "A", suit: "H" }), "AH");
});

test("rankValue returns correct values", () => {
  assert.strictEqual(rankValue("J"), 1);
  assert.strictEqual(rankValue("Q"), 2);
  assert.strictEqual(rankValue("K"), 3);
  assert.strictEqual(rankValue("10"), 4);
  assert.strictEqual(rankValue("A"), 5);
});

test("makeDeck has exactly 4 of every unique card", () => {
  const deck = makeDeck();
  assert.strictEqual(deck.length, 80);

  const counts = {};
  for (const card of deck) {
    counts[card] = (counts[card] || 0) + 1;
  }

  assert.strictEqual(Object.keys(counts).length, 20, "should have 20 unique cards");
  for (const [card, count] of Object.entries(counts)) {
    assert.strictEqual(count, 4, `${card} should appear 4 times`);
  }
});

test("shuffle changes the order", () => {
  const original = makeDeck();
  const toShuffle = [...original];  // copy before shuffling
  shuffle(toShuffle);
  assert.notDeepEqual(toShuffle, original);
});

test("shuffle preserves all elements", () => {
  const original = makeDeck();
  const toShuffle = [...original];
  shuffle(toShuffle);
  assert.deepEqual(toShuffle.slice().sort(), original.slice().sort());
});