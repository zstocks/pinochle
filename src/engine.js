// The rules-engine orchestrator — the capstone of Layer 1.
//
// One public function: apply(state, action) -> { state, events } | { error }.
//
// `apply` is pure: it never mutates the input state. It deep-clones the state,
// dispatches the action by phase, and returns a new state plus the events that
// action produced. Actions are either accepted (new state + events) or rejected
// as a *player error* ({ error: "..." }). Inputs that should be impossible if
// the rest of the system is correct (malformed actions, broken invariants) throw
// — "programmer errors throw, player errors return" (see CLAUDE.md).
//
// Phase machine:
//
//   dealing -> bidding -> awaiting_trump -> meld -> tricks -> [score] -> dealing
//                  |                                                       |
//                  +-- dealer-no-marriage -> meld -> [score] --------------+--> complete
//
// Two phases are "all four players must act" barriers driven by readiness:
//   - dealing: each seat sends start_game; when all four are ready the hand is
//     dealt. This gates the first hand and every subsequent one, so players can
//     review the prior hand's result before the next deal.
//   - meld: meld is auto-computed and revealed (teams >= 20 are shown, teams < 20
//     reveal nothing). Each seat sends acknowledge_meld; when all four have, play
//     begins (or the hand is scored, in the no-marriage case).

import { parseCard, isCounter } from "./cards.js";
import { teamOf, nextSeat, dealHand } from "./state.js";
import { legalPlays, trickWinner, canClaimRemaining } from "./tricks.js";
import { computeMeld } from "./meld.js";
import { scoreHand, scoreDealerNoMarriage } from "./scoring.js";

const SUITS = ["C", "D", "H", "S"];
const NUM_SEATS = 4;

// Bidding (rules.md §5).
const OPENING_BID = 50;
const HIGH_BID_THRESHOLD = 60;   // at/above this, bids jump by HIGH_BID_INCREMENT
const LOW_BID_INCREMENT = 1;     // below the threshold, bids rise by at least this
const HIGH_BID_INCREMENT = 5;
const DEALER_AUTO_TAKE_BID = 50;

// Trick-taking / counters (rules.md §7).
const TRICKS_PER_HAND = 20;
const LAST_TRICK_BONUS = 2;
const TOTAL_COUNTERS = 50;

const ACTION_TYPES = new Set([
    "start_game",
    "bid",
    "pass",
    "declare_trump",
    "acknowledge_meld",
    "play_card",
    "claim_remaining"
]);

// ----- Public API -------------------------------------------------------------

export function apply(state, action) {
    // Malformed actions are programmer errors — Layer 3 validates the wire schema
    // before anything reaches here, so a bad shape means a bug upstream.
    if (action === null || typeof action !== "object" || Array.isArray(action)) {
        throw new Error("action must be an object");
    }
    if (!ACTION_TYPES.has(action.type)) {
        throw new Error(`unknown action type "${action.type}"`);
    }
    if (!Number.isInteger(action.actor) || action.actor < 0 || action.actor >= NUM_SEATS) {
        throw new Error(`action.actor must be an integer 0..3, got ${action.actor}`);
    }

    // Deep-clone once, then mutate the clone freely. Cheaper to reason about than
    // threading spreads through deeply-nested state, and state is plain JSON so
    // structuredClone is safe. The original is never returned, so player-error
    // paths (which return { error } and discard the clone) leave it untouched.
    const s = structuredClone(state);
    const events = [];

    switch (action.type) {
        case "start_game":       return handleStartGame(s, action, events);
        case "bid":              return handleBid(s, action, events);
        case "pass":             return handlePass(s, action, events);
        case "declare_trump":    return handleDeclareTrump(s, action, events);
        case "acknowledge_meld": return handleAcknowledgeMeld(s, action, events);
        case "play_card":        return handlePlayCard(s, action, events);
        case "claim_remaining":  return handleClaimRemaining(s, action, events);
    }
}

// ----- Phase handlers ---------------------------------------------------------

function handleStartGame(s, { actor }, events) {
    if (s.phase !== "dealing") return wrongPhase(s.phase, "start_game");
    if (s.ready[actor]) return { error: "you are already ready" };

    s.ready[actor] = true;
    events.push({ type: "player_ready", seat: actor });
    if (!s.ready.every(Boolean)) return { state: s, events };

    // All four ready: deal a fresh hand. dealHand advances to "bidding" and sets
    // the leader; we reset the per-hand sub-states so nothing leaks between hands.
    const dealt = dealHand(s);
    dealt.bidding = freshBidding();
    dealt.meld = freshMeld();
    dealt.tricks = freshTricks();
    dealt.ready = freshReady();
    dealt.declarer = null;
    dealt.dealerNoMarriage = false;
    events.push({ type: "hand_dealt", dealer: dealt.dealer });
    return { state: dealt, events };
}

function handleBid(s, { actor, amount }, events) {
    if (s.phase !== "bidding") return wrongPhase(s.phase, "bid");
    if (actor !== s.currentPlayer) return { error: "it is not your turn" };
    if (s.bidding.passed[actor]) return { error: "you have already passed" };
    if (!hasMarriage(s.seats[actor].hand)) {
        return { error: "you must hold a marriage to bid" };
    }
    if (!Number.isInteger(amount)) return { error: "bid amount must be an integer" };

    const minimum = minimumBid(s.bidding.currentBid);
    if (amount < minimum) return { error: `bid must be at least ${minimum}` };

    s.bidding.currentBid = amount;
    s.bidding.highBidder = actor;
    events.push({ type: "bid_made", seat: actor, amount });
    s.currentPlayer = nextActiveBidder(actor, s.bidding.passed);
    return { state: s, events };
}

function handlePass(s, { actor }, events) {
    if (s.phase !== "bidding") return wrongPhase(s.phase, "pass");
    if (actor !== s.currentPlayer) return { error: "it is not your turn" };
    if (s.bidding.passed[actor]) return { error: "you have already passed" };

    s.bidding.passed[actor] = true;
    events.push({ type: "bid_passed", seat: actor });

    // The auction ends once three players are out — one bidder remains.
    if (s.bidding.passed.filter(Boolean).length === NUM_SEATS - 1) {
        return resolveAuction(s, events);
    }
    s.currentPlayer = nextActiveBidder(actor, s.bidding.passed);
    return { state: s, events };
}

function handleDeclareTrump(s, { actor, suit }, events) {
    if (s.phase !== "awaiting_trump") return wrongPhase(s.phase, "declare_trump");
    if (actor !== s.declarer) return { error: "only the declarer may name trump" };
    if (!SUITS.includes(suit)) return { error: `invalid trump suit "${suit}"` };
    if (!hasMarriageInSuit(s.seats[actor].hand, suit)) {
        return { error: "you must hold a marriage in the trump suit" };
    }

    s.bidding.trump = suit;
    events.push({ type: "trump_declared", seat: actor, suit });
    return enterMeldPhase(s, suit, events);
}

function handleAcknowledgeMeld(s, { actor }, events) {
    if (s.phase !== "meld") return wrongPhase(s.phase, "acknowledge_meld");
    if (s.ready[actor]) return { error: "you have already acknowledged the meld" };

    s.ready[actor] = true;
    events.push({ type: "meld_acknowledged", seat: actor });
    if (!s.ready.every(Boolean)) return { state: s, events };

    if (s.dealerNoMarriage) {
        // No tricks are played; the hand is scored straight from meld (rules.md §8).
        const result = scoreDealerNoMarriage({
            dealerTeam: teamOf(s.declarer),
            meld: s.meld.teamTotals
        });
        return finishHand(s, result, events);
    }

    s.phase = "tricks";
    s.ready = freshReady();
    s.currentPlayer = s.declarer;   // the declarer leads the first trick
    events.push({ type: "tricks_begin", leader: s.declarer });
    return { state: s, events };
}

function handlePlayCard(s, { actor, card }, events) {
    if (s.phase !== "tricks") return wrongPhase(s.phase, "play_card");
    if (actor !== s.currentPlayer) return { error: "it is not your turn" };

    const hand = s.seats[actor].hand;
    if (!hand.includes(card)) return { error: "you do not hold that card" };
    if (!legalPlays(hand, s.tricks.currentTrick, s.bidding.trump).includes(card)) {
        return { error: "that card is not a legal play" };
    }

    hand.splice(hand.indexOf(card), 1);
    s.tricks.currentTrick.push({ seat: actor, card });
    if (s.tricks.currentTrick.length === 1) {
        s.tricks.ledSuit = parseCard(card).suit;
    }
    events.push({ type: "card_played", seat: actor, card });

    if (s.tricks.currentTrick.length < NUM_SEATS) {
        s.currentPlayer = nextSeat(actor);
        return { state: s, events };
    }
    return completeTrick(s, events);
}

// A "trump attack": the leader holds only trump and no opponent holds any, so
// they're guaranteed every remaining trick. Award all remaining card counters
// plus the last-trick bonus to their team and score the hand, rather than
// playing the formality out (rules.md §7 plays this out card-by-card; this is a
// house shortcut with the same outcome).
function handleClaimRemaining(s, { actor }, events) {
    if (s.phase !== "tricks") return wrongPhase(s.phase, "claim_remaining");
    if (actor !== s.currentPlayer) return { error: "it is not your turn" };
    if (s.tricks.currentTrick.length !== 0) return { error: "you can only claim while leading a trick" };
    if (!canClaimRemaining(s.seats, actor, s.bidding.trump)) {
        return { error: "you can only claim when you hold nothing but trump and no opponent holds any" };
    }

    let remaining = 0;
    for (const seat of s.seats) {
        for (const card of seat.hand) if (isCounter(card)) remaining += 1;
    }
    s.tricks.counters[teamOf(actor)] += remaining + LAST_TRICK_BONUS;
    s.tricks.trumpAttack = { seat: actor, trump: s.bidding.trump };
    events.push({ type: "trump_attack", seat: actor, trump: s.bidding.trump });

    const counterSum = s.tricks.counters.team_A + s.tricks.counters.team_B;
    if (counterSum !== TOTAL_COUNTERS) {
        throw new Error(`counters summed to ${counterSum}, expected ${TOTAL_COUNTERS}`);
    }

    const result = scoreHand({
        bid: s.bidding.currentBid,
        declarerTeam: teamOf(s.declarer),
        meld: s.meld.teamTotals,
        counters: s.tricks.counters
    });
    return finishHand(s, result, events);
}

// ----- Auction resolution -----------------------------------------------------

function resolveAuction(s, events) {
    if (s.bidding.highBidder !== null) {
        s.declarer = s.bidding.highBidder;
        events.push({ type: "auction_won", declarer: s.declarer, bid: s.bidding.currentBid });
        s.phase = "awaiting_trump";
        s.currentPlayer = s.declarer;
        return { state: s, events };
    }

    // Nobody bid: all three non-dealers passed, so the dealer auto-takes at 50.
    s.declarer = s.dealer;
    s.bidding.currentBid = DEALER_AUTO_TAKE_BID;
    s.bidding.highBidder = s.dealer;
    events.push({ type: "dealer_auto_take", dealer: s.dealer, bid: DEALER_AUTO_TAKE_BID });

    if (hasMarriage(s.seats[s.dealer].hand)) {
        s.phase = "awaiting_trump";
        s.currentPlayer = s.dealer;
        return { state: s, events };
    }

    // Dealer auto-take with no marriage (rules.md §5): the dealing team is set 50,
    // no trump is named, the non-dealing team still shows meld, no tricks played.
    s.dealerNoMarriage = true;
    events.push({ type: "dealer_no_marriage", dealer: s.dealer });
    return enterMeldPhase(s, null, events);
}

// ----- Meld phase -------------------------------------------------------------

// Compute every seat's meld under `trump` (null for the no-marriage case),
// publish the team totals, and open the acknowledge_meld barrier. The engine
// stores the full per-seat breakdown as ground truth; redacting teams that fall
// below the show threshold is Layer 3's job when building per-player views.
function enterMeldPhase(s, trump, events) {
    const declared = s.seats.map((seat) => computeMeld(seat.hand, trump));
    const teamTotals = { team_A: 0, team_B: 0 };
    for (let seat = 0; seat < NUM_SEATS; seat++) {
        teamTotals[teamOf(seat)] += declared[seat].total;
    }

    s.meld = { declared, teamTotals };
    s.ready = freshReady();
    s.phase = "meld";
    events.push({ type: "meld_computed", teamTotals });
    return { state: s, events };
}

// ----- Trick completion -------------------------------------------------------

function completeTrick(s, events) {
    const trick = s.tricks.currentTrick;
    const winner = trickWinner(trick, s.bidding.trump);
    const isLastTrick = s.tricks.completed.length === TRICKS_PER_HAND - 1;

    let counters = countCounters(trick);
    if (isLastTrick) counters += LAST_TRICK_BONUS;
    s.tricks.counters[teamOf(winner)] += counters;

    s.tricks.completed.push({ cards: trick, winner });
    s.tricks.currentTrick = [];
    s.tricks.ledSuit = null;
    s.currentPlayer = winner;   // winner leads the next trick
    events.push({ type: "trick_won", winner, counters, lastTrick: isLastTrick });

    if (s.tricks.completed.length < TRICKS_PER_HAND) {
        return { state: s, events };
    }

    // Hand is over. Every counter is accounted for, so the totals must sum to 50;
    // anything else is a bug in trick handling, not a player error.
    const counterSum = s.tricks.counters.team_A + s.tricks.counters.team_B;
    if (counterSum !== TOTAL_COUNTERS) {
        throw new Error(`counters summed to ${counterSum}, expected ${TOTAL_COUNTERS}`);
    }

    const result = scoreHand({
        bid: s.bidding.currentBid,
        declarerTeam: teamOf(s.declarer),
        meld: s.meld.teamTotals,
        counters: s.tricks.counters
    });
    return finishHand(s, result, events);
}

// ----- Hand and game completion -----------------------------------------------

function finishHand(s, result, events) {
    s.scores.team_A += result.team_A;
    s.scores.team_B += result.team_B;

    s.lastHandResult = {
        deltas: { team_A: result.team_A, team_B: result.team_B },
        scores: { ...s.scores },
        declarerTeam: teamOf(s.declarer),
        declarerSet: result.declarerSet,
        bid: s.bidding.currentBid,
        meld: { ...s.meld.teamTotals },
        counters: { ...s.tricks.counters },
        dealerNoMarriage: s.dealerNoMarriage,
        trumpAttack: s.tricks.trumpAttack || null
    };
    events.push({ type: "hand_scored", result: s.lastHandResult });

    if (s.scores.team_A >= s.targetScore || s.scores.team_B >= s.targetScore) {
        s.winner = decideWinner(s);
        s.phase = "complete";
        events.push({ type: "game_over", winner: s.winner });
        return { state: s, events };
    }

    // Next hand: rotate the deal clockwise and re-open the start_game barrier.
    s.dealer = nextSeat(s.dealer);
    s.phase = "dealing";
    s.ready = freshReady();
    s.currentPlayer = null;
    return { state: s, events };
}

// Both teams over the target in the same hand → the declarer's team wins the tie
// (rules.md §8). Otherwise the team that reached it wins.
function decideWinner(s) {
    const aReached = s.scores.team_A >= s.targetScore;
    const bReached = s.scores.team_B >= s.targetScore;
    if (aReached && bReached) return teamOf(s.declarer);
    return aReached ? "team_A" : "team_B";
}

// ----- Small helpers ----------------------------------------------------------

function wrongPhase(phase, type) {
    return { error: `action "${type}" is not valid during phase "${phase}"` };
}

function hasMarriage(hand) {
    return SUITS.some((suit) => hasMarriageInSuit(hand, suit));
}

function hasMarriageInSuit(hand, suit) {
    return hand.includes("K" + suit) && hand.includes("Q" + suit);
}

// The minimum legal next bid given the current high bid (0 = no bid yet).
function minimumBid(currentBid) {
    if (currentBid === 0) return OPENING_BID;
    if (currentBid < HIGH_BID_THRESHOLD) return currentBid + LOW_BID_INCREMENT;
    return currentBid + HIGH_BID_INCREMENT;
}

// The next seat clockwise that hasn't passed. Only called while at least two
// players remain in the auction, so it always lands on a different active seat.
function nextActiveBidder(seat, passed) {
    let next = nextSeat(seat);
    while (passed[next]) next = nextSeat(next);
    return next;
}

function countCounters(trick) {
    return trick.reduce((sum, { card }) => sum + (isCounter(card) ? 1 : 0), 0);
}

// Fresh per-hand sub-states. These mirror the shapes in createInitialState;
// kept here so a deal fully resets the hand without reaching back into state.js.
function freshBidding() {
    return { currentBid: 0, highBidder: null, passed: [false, false, false, false], trump: null };
}

function freshMeld() {
    return { declared: [null, null, null, null], teamTotals: { team_A: 0, team_B: 0 } };
}

function freshTricks() {
    return { currentTrick: [], ledSuit: null, completed: [], counters: { team_A: 0, team_B: 0 } };
}

function freshReady() {
    return [false, false, false, false];
}
