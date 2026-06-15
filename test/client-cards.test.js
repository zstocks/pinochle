import { test } from "node:test";
import assert from "node:assert/strict";
import {
    sortByRank,
    groupBySuit,
    countsBySuit,
    hasMarriage,
    marriageSuits,
    minBid,
    bidStep,
    seatLabel,
    seatTeamColor
} from "../public/js/cards.js";

test("sortByRank orders A > 10 > K > Q > J", () => {
    assert.deepEqual(sortByRank(["JS", "AS", "QS", "10S", "KS"]), ["AS", "10S", "KS", "QS", "JS"]);
});

test("groupBySuit splits and sorts each suit", () => {
    const groups = groupBySuit(["KD", "AS", "QD", "JS", "AD"]);
    assert.deepEqual(groups.D, ["AD", "KD", "QD"]);
    assert.deepEqual(groups.S, ["AS", "JS"]);
    assert.deepEqual(groups.C, []);
    assert.deepEqual(groups.H, []);
});

test("countsBySuit tallies per suit", () => {
    assert.deepEqual(countsBySuit(["AS", "KS", "AD"]), { S: 2, D: 1, C: 0, H: 0 });
});

test("hasMarriage / marriageSuits detect K+Q pairs", () => {
    assert.strictEqual(hasMarriage(["KS", "QS", "AD"]), true);
    assert.strictEqual(hasMarriage(["KS", "QD"]), false);
    assert.deepEqual(marriageSuits(["KS", "QS", "KH", "QH", "KD"]), ["S", "H"]);
});

test("minBid follows the opening and increment rules", () => {
    assert.strictEqual(minBid(0), 50);   // opening
    assert.strictEqual(minBid(50), 51);  // +1 below 60
    assert.strictEqual(minBid(59), 60);
    assert.strictEqual(minBid(60), 65);  // +5 at/above 60
    assert.strictEqual(minBid(85), 90);
});

test("bidStep is 1 below 60 and 5 at/above", () => {
    assert.strictEqual(bidStep(55), 1);
    assert.strictEqual(bidStep(60), 5);
});

test("seat labels map to Red/Black teams (even = Red, odd = Black)", () => {
    assert.deepEqual(
        [0, 1, 2, 3].map(seatLabel),
        ["Red Player 1", "Black Player 1", "Red Player 2", "Black Player 2"]
    );
    assert.deepEqual([0, 1, 2, 3].map(seatTeamColor), ["red", "black", "red", "black"]);
});
