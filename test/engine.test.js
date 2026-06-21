import { test } from "node:test";
import assert from "node:assert/strict";
import { apply } from "../src/engine.js";
import { createInitialState, nextSeat, teamOf } from "../src/state.js";
import { legalPlays } from "../src/tricks.js";
import { scoreHand } from "../src/scoring.js";
import { makeDeck } from "../src/cards.js";

const NAMES = ["Alice", "Bob", "Carol", "Dave"];

// Four hands that each hold a club marriage, so every seat is bid-eligible.
const ELIGIBLE = () => [["KC", "QC"], ["KC", "QC"], ["KC", "QC"], ["KC", "QC"]];

// Build a state already in the bidding phase with controlled hands. The engine's
// bidding logic doesn't care about hand size, so short hands are fine here.
function biddingState(hands, dealer = 0) {
    const s = createInitialState(NAMES);
    s.dealer = dealer;
    s.phase = "bidding";
    s.currentPlayer = nextSeat(dealer);
    hands.forEach((hand, i) => { s.seats[i].hand = hand; });
    return s;
}

// A deterministic deal: makeDeck() has a fixed order, so each seat gets a full
// suit (seat 0 = clubs, 1 = diamonds, 2 = hearts, 3 = spades). Every seat holds
// that suit's K+Q (a marriage), so all four are eligible to bid.
function dealtBiddingState(dealer = 0) {
    const deck = makeDeck();
    const s = createInitialState(NAMES);
    s.dealer = dealer;
    s.phase = "bidding";
    s.currentPlayer = nextSeat(dealer);
    for (let i = 0; i < 4; i++) s.seats[i].hand = deck.slice(i * 20, i * 20 + 20);
    return s;
}

// Play out the trick phase by always choosing the first legal card.
function playOutTricks(result) {
    let r = result;
    const trump = r.state.bidding.trump;
    let guard = 0;
    while (r.state.phase === "tricks") {
        const seat = r.state.currentPlayer;
        const legal = legalPlays(r.state.seats[seat].hand, r.state.tricks.currentTrick, trump);
        r = apply(r.state, { actor: seat, type: "play_card", card: legal[0] });
        if (++guard > 100) throw new Error("trick loop did not terminate");
    }
    return r;
}

// ----- start_game barrier -----------------------------------------------------

test("start_game deals only after all four players are ready", () => {
    let r = { state: createInitialState(NAMES) };
    r = apply(r.state, { actor: 0, type: "start_game" });
    r = apply(r.state, { actor: 1, type: "start_game" });
    r = apply(r.state, { actor: 2, type: "start_game" });
    assert.strictEqual(r.state.phase, "dealing");  // still waiting on seat 3

    r = apply(r.state, { actor: 3, type: "start_game" });
    assert.strictEqual(r.state.phase, "bidding");
    for (const seat of r.state.seats) assert.strictEqual(seat.hand.length, 20);
    assert.strictEqual(r.state.currentPlayer, nextSeat(r.state.dealer));
    assert.deepEqual(r.state.ready, [false, false, false, false]);  // barrier reset
});

test("start_game from a seat that is already ready is rejected", () => {
    const first = apply(createInitialState(NAMES), { actor: 0, type: "start_game" });
    assert.ok(apply(first.state, { actor: 0, type: "start_game" }).error);
});

// ----- Bidding ----------------------------------------------------------------

test("bidding opens at 50", () => {
    const s = biddingState(ELIGIBLE(), 0);   // currentPlayer = 1
    assert.match(apply(s, { actor: 1, type: "bid", amount: 49 }).error, /at least 50/);

    const r = apply(s, { actor: 1, type: "bid", amount: 50 });
    assert.strictEqual(r.state.bidding.currentBid, 50);
    assert.strictEqual(r.state.bidding.highBidder, 1);
    assert.strictEqual(r.state.currentPlayer, 2);
});

test("bids rise by 1 below 60 and by 5 at/above 60", () => {
    const s = biddingState(ELIGIBLE(), 0);
    s.currentPlayer = 1;

    s.bidding.currentBid = 59; s.bidding.highBidder = 0;
    assert.ok(apply(s, { actor: 1, type: "bid", amount: 59 }).error);
    assert.ok(!apply(s, { actor: 1, type: "bid", amount: 60 }).error);

    s.bidding.currentBid = 60;
    assert.ok(apply(s, { actor: 1, type: "bid", amount: 64 }).error);
    assert.ok(!apply(s, { actor: 1, type: "bid", amount: 65 }).error);
});

test("a player without a marriage cannot bid", () => {
    const s = biddingState([["KC", "QC"], ["AC", "10D"], ["KC", "QC"], ["KC", "QC"]], 0);
    assert.match(apply(s, { actor: 1, type: "bid", amount: 50 }).error, /marriage/);
});

test("acting out of turn is rejected", () => {
    const s = biddingState(ELIGIBLE(), 0);   // currentPlayer = 1
    assert.match(apply(s, { actor: 2, type: "bid", amount: 50 }).error, /your turn/);
});

test("auction resolves to the high bidder after three passes", () => {
    const s = biddingState(ELIGIBLE(), 0);   // currentPlayer = 1
    let r = apply(s, { actor: 1, type: "bid", amount: 55 });
    r = apply(r.state, { actor: 2, type: "pass" });
    r = apply(r.state, { actor: 3, type: "pass" });
    r = apply(r.state, { actor: 0, type: "pass" });   // dealer passes

    assert.strictEqual(r.state.phase, "awaiting_trump");
    assert.strictEqual(r.state.declarer, 1);
    assert.strictEqual(r.state.bidding.currentBid, 55);
});

test("dealer auto-takes at 50 when all three non-dealers pass", () => {
    const s = biddingState(ELIGIBLE(), 0);   // dealer 0, currentPlayer 1
    let r = apply(s, { actor: 1, type: "pass" });
    r = apply(r.state, { actor: 2, type: "pass" });
    r = apply(r.state, { actor: 3, type: "pass" });

    assert.strictEqual(r.state.phase, "awaiting_trump");
    assert.strictEqual(r.state.declarer, 0);
    assert.strictEqual(r.state.bidding.currentBid, 50);
});

// ----- declare_trump ----------------------------------------------------------

test("only the declarer may name trump, and only a suit they hold a marriage in", () => {
    const s = biddingState(ELIGIBLE(), 0);
    let r = apply(s, { actor: 1, type: "bid", amount: 50 });
    r = apply(r.state, { actor: 2, type: "pass" });
    r = apply(r.state, { actor: 3, type: "pass" });
    r = apply(r.state, { actor: 0, type: "pass" });   // declarer = 1, awaiting_trump

    assert.match(apply(r.state, { actor: 2, type: "declare_trump", suit: "C" }).error, /declarer/);
    assert.match(apply(r.state, { actor: 1, type: "declare_trump", suit: "H" }).error, /marriage in the trump/);

    const ok = apply(r.state, { actor: 1, type: "declare_trump", suit: "C" });
    assert.strictEqual(ok.state.phase, "meld");
    assert.strictEqual(ok.state.bidding.trump, "C");
    // Meld auto-computed: each seat's club marriage is now a trump marriage (4).
    assert.deepEqual(ok.state.meld.teamTotals, { team_A: 8, team_B: 8 });
});

// ----- Dealer-no-marriage path ------------------------------------------------

test("dealer auto-take with no marriage sets the dealing team and skips tricks", () => {
    const rr = ["KC", "QC", "KD", "QD", "KH", "QH", "KS", "QS"];  // round robin = 24
    // dealer 0 (team_A) has no marriage; team_B (seats 1 and 3) each hold a round robin.
    const s = biddingState([["AC", "10D", "AH", "10S"], rr, ["AC", "10D"], rr], 0);
    let r = apply(s, { actor: 1, type: "pass" });
    r = apply(r.state, { actor: 2, type: "pass" });
    r = apply(r.state, { actor: 3, type: "pass" });

    assert.strictEqual(r.state.phase, "meld");
    assert.strictEqual(r.state.dealerNoMarriage, true);
    assert.deepEqual(r.state.meld.teamTotals, { team_A: 0, team_B: 48 });  // computed under no trump

    for (let seat = 0; seat < 4; seat++) {
        r = apply(r.state, { actor: seat, type: "acknowledge_meld" });
    }
    assert.strictEqual(r.state.lastHandResult.deltas.team_A, -50);  // dealing team set
    assert.strictEqual(r.state.lastHandResult.deltas.team_B, 48);   // opponents save meld
    assert.strictEqual(r.state.phase, "dealing");
    assert.strictEqual(r.state.dealer, 1);   // dealer rotated for the next hand
});

// ----- Full hand: deal through scoring -----------------------------------------

test("a full hand plays from auction through trick scoring", () => {
    let r = { state: dealtBiddingState(0) };   // currentPlayer 1
    r = apply(r.state, { actor: 1, type: "bid", amount: 50 });
    r = apply(r.state, { actor: 2, type: "pass" });
    r = apply(r.state, { actor: 3, type: "pass" });
    r = apply(r.state, { actor: 0, type: "pass" });
    assert.strictEqual(r.state.declarer, 1);

    r = apply(r.state, { actor: 1, type: "declare_trump", suit: "D" });  // seat 1 = diamonds
    assert.strictEqual(r.state.phase, "meld");

    for (let seat = 0; seat < 4; seat++) {
        r = apply(r.state, { actor: seat, type: "acknowledge_meld" });
    }
    assert.strictEqual(r.state.phase, "tricks");
    assert.strictEqual(r.state.currentPlayer, 1);   // declarer leads

    const meldTotals = { ...r.state.meld.teamTotals };
    r = playOutTricks(r);

    const counters = r.state.lastHandResult.counters;
    assert.strictEqual(counters.team_A + counters.team_B, 50);

    const expected = scoreHand({
        bid: 50, declarerTeam: teamOf(1), meld: meldTotals, counters
    });
    assert.strictEqual(r.state.lastHandResult.deltas.team_A, expected.team_A);
    assert.strictEqual(r.state.lastHandResult.deltas.team_B, expected.team_B);
    assert.ok(r.state.phase === "dealing" || r.state.phase === "complete");
});

// ----- Game end ---------------------------------------------------------------

test("game completes when a team reaches the target score", () => {
    const rr = ["KC", "QC", "KD", "QD", "KH", "QH", "KS", "QS"];
    const s = biddingState([["AC", "10D"], rr, ["AC", "10D"], rr], 0);
    s.scores.team_B = 460;   // +48 from the no-marriage save will cross 500
    let r = apply(s, { actor: 1, type: "pass" });
    r = apply(r.state, { actor: 2, type: "pass" });
    r = apply(r.state, { actor: 3, type: "pass" });
    for (let seat = 0; seat < 4; seat++) {
        r = apply(r.state, { actor: seat, type: "acknowledge_meld" });
    }
    assert.strictEqual(r.state.phase, "complete");
    assert.strictEqual(r.state.winner, "team_B");
});

test("both teams over target in one hand: the declarer's team wins the tie", () => {
    let r = { state: dealtBiddingState(3) };   // currentPlayer 0
    r.state.scores.team_A = 480;
    r.state.scores.team_B = 505;   // already over, but only checked at hand end
    r = apply(r.state, { actor: 0, type: "bid", amount: 50 });
    r = apply(r.state, { actor: 1, type: "pass" });
    r = apply(r.state, { actor: 2, type: "pass" });
    r = apply(r.state, { actor: 3, type: "pass" });
    assert.strictEqual(r.state.declarer, 0);   // team_A

    r = apply(r.state, { actor: 0, type: "declare_trump", suit: "C" });  // seat 0 = clubs
    for (let seat = 0; seat < 4; seat++) {
        r = apply(r.state, { actor: seat, type: "acknowledge_meld" });
    }
    r = playOutTricks(r);

    assert.strictEqual(r.state.phase, "complete");
    assert.ok(r.state.scores.team_A >= 500 && r.state.scores.team_B >= 500);
    assert.strictEqual(r.state.winner, "team_A");   // declarer's team takes the tie
});

// ----- Errors and purity ------------------------------------------------------

test("apply does not mutate the input state", () => {
    const s = createInitialState(NAMES);
    const snapshot = JSON.stringify(s);
    apply(s, { actor: 0, type: "start_game" });
    assert.strictEqual(JSON.stringify(s), snapshot);
});

test("malformed actions throw (programmer errors)", () => {
    const s = createInitialState(NAMES);
    assert.throws(() => apply(s, null), /action must be an object/);
    assert.throws(() => apply(s, { actor: 0, type: "frobnicate" }), /unknown action type/);
    assert.throws(() => apply(s, { actor: 5, type: "start_game" }), /actor must be/);
});

test("actions used in the wrong phase return a player error", () => {
    const s = createInitialState(NAMES);   // phase "dealing"
    assert.match(apply(s, { actor: 0, type: "bid", amount: 50 }).error, /not valid during phase/);
    assert.match(apply(s, { actor: 0, type: "play_card", card: "AS" }).error, /not valid during phase/);
});

// ----- Trump attack (claim_remaining) -----------------------------------------

// A trick-phase state where seat 0 leads holding only trump (spades) and no one
// else holds any. Counters already collected (20/20) leave room for the 8
// remaining (all counter cards) + last-trick bonus to sum to 50.
function trumpAttackState() {
    const s = createInitialState(NAMES);
    s.phase = "tricks";
    s.declarer = 0;
    s.currentPlayer = 0;
    s.bidding = { currentBid: 50, highBidder: 0, passed: [false, false, false, false], trump: "S" };
    s.meld = { declared: [null, null, null, null], teamTotals: { team_A: 40, team_B: 0 } };
    s.tricks = { currentTrick: [], ledSuit: null, completed: [], counters: { team_A: 20, team_B: 20 } };
    s.seats[0].hand = ["AS", "10S"];
    s.seats[1].hand = ["AH", "10H"];
    s.seats[2].hand = ["AD", "10D"];
    s.seats[3].hand = ["AC", "10C"];
    return s;
}

test("claim_remaining sweeps the rest to the claimer's team and scores the hand", () => {
    const r = apply(trumpAttackState(), { actor: 0, type: "claim_remaining" });
    assert.deepEqual(r.state.lastHandResult.trumpAttack, { seat: 0, trump: "S" });
    // 8 remaining counters + 2 last-trick bonus → team_A 20 + 10 = 30; sums to 50.
    assert.strictEqual(r.state.lastHandResult.counters.team_A, 30);
    assert.strictEqual(r.state.lastHandResult.counters.team_B, 20);
    // Declarer (team_A) makes: meld 40 + counters 30 = +70. Opponents: counters only +20.
    assert.strictEqual(r.state.lastHandResult.deltas.team_A, 70);
    assert.strictEqual(r.state.lastHandResult.deltas.team_B, 20);
    assert.ok(r.events.some((e) => e.type === "trump_attack"));
    assert.strictEqual(r.state.phase, "dealing");
});

test("claim_remaining is rejected when an opponent still holds trump", () => {
    const s = trumpAttackState();
    s.seats[1].hand = ["KS", "10H"];   // opponent now has a spade
    assert.match(apply(s, { actor: 0, type: "claim_remaining" }).error, /trump/);
});

test("claim_remaining is rejected mid-trick (not leading)", () => {
    const s = trumpAttackState();
    s.tricks.currentTrick = [{ seat: 3, card: "AC" }];
    assert.match(apply(s, { actor: 0, type: "claim_remaining" }).error, /leading/);
});
