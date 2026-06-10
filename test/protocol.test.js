import { test } from "node:test";
import assert from "node:assert/strict";
import {
    PROTOCOL_VERSION,
    validateMessage,
    handleClientMessage,
    redactStateFor,
    redactEvents
} from "../src/protocol.js";
import { createRoomManager } from "../src/room.js";

const V = PROTOCOL_VERSION;

// ----- validateMessage --------------------------------------------------------

test("a well-formed message validates", () => {
    assert.deepEqual(validateMessage({ protocol_version: V, type: "create_room", name: "Al" }), { ok: true });
    assert.deepEqual(
        validateMessage({ protocol_version: V, type: "join_room", code: "ABCD", name: "Al", seat: 2 }),
        { ok: true }
    );
});

test("wrong protocol_version is rejected", () => {
    const r = validateMessage({ protocol_version: 99, type: "create_room", name: "Al" });
    assert.match(r.error, /protocol_version/);
});

test("unknown message type is rejected", () => {
    assert.match(validateMessage({ protocol_version: V, type: "nope" }).error, /unknown message type/);
});

test("missing and wrong-typed fields are rejected", () => {
    assert.match(validateMessage({ protocol_version: V, type: "join_room", name: "Al", seat: 1 }).error, /code/);
    assert.match(
        validateMessage({ protocol_version: V, type: "join_room", code: "ABCD", name: "Al", seat: "x" }).error,
        /seat/
    );
});

test("unexpected fields are rejected", () => {
    const r = validateMessage({ protocol_version: V, type: "create_room", name: "Al", evil: 1 });
    assert.match(r.error, /unexpected field "evil"/);
});

test("optional fields are allowed but still type-checked", () => {
    assert.deepEqual(validateMessage({ protocol_version: V, type: "create_room", name: "Al", seat: 3 }), { ok: true });
    assert.match(
        validateMessage({ protocol_version: V, type: "create_room", name: "Al", seat: 1.5 }).error,
        /seat/
    );
});

test("action messages validate their nested action", () => {
    assert.deepEqual(
        validateMessage({ protocol_version: V, type: "action", action: { type: "bid", amount: 50 } }),
        { ok: true }
    );
    assert.match(
        validateMessage({ protocol_version: V, type: "action", action: { type: "bid" } }).error,
        /amount/
    );
    assert.match(
        validateMessage({ protocol_version: V, type: "action", action: { type: "teleport" } }).error,
        /unknown action type/
    );
    // A client-supplied actor is an unexpected field — the server injects it.
    assert.match(
        validateMessage({ protocol_version: V, type: "action", action: { type: "pass", actor: 2 } }).error,
        /unexpected field "actor"/
    );
});

// ----- handleClientMessage ----------------------------------------------------

function ctx(extra) {
    return { roomManager: createRoomManager(), ownerKey: "ip-1", now: 0, session: null, ...extra };
}

test("create_room replies joined, sets a session, and broadcasts the room", () => {
    const c = ctx();
    const r = handleClientMessage({ ...c, message: { protocol_version: V, type: "create_room", name: "Al" } });
    assert.strictEqual(r.reply.type, "joined");
    assert.ok(r.reply.token);
    assert.strictEqual(r.session.seat, 0);
    assert.strictEqual(r.broadcast.code, r.reply.code);
});

test("an action without a session is rejected", () => {
    const c = ctx();
    const r = handleClientMessage({
        ...c,
        message: { protocol_version: V, type: "action", action: { type: "start_game" } }
    });
    assert.match(r.reply.message, /not in a room/);
});

test("actions inject the session's seat and broadcast engine events", () => {
    const roomManager = createRoomManager();
    // Stand up a full room directly so we have a live game.
    const created = roomManager.createRoom({ name: "A", now: 0 });
    roomManager.joinRoom({ code: created.code, name: "B", seat: 1, now: 0 });
    roomManager.joinRoom({ code: created.code, name: "C", seat: 2, now: 0 });
    roomManager.joinRoom({ code: created.code, name: "D", seat: 3, now: 0 });

    const session = { code: created.code, seat: 0, token: created.token };
    const r = handleClientMessage({
        roomManager, ownerKey: "ip", now: 1, session,
        message: { protocol_version: V, type: "action", action: { type: "start_game" } }
    });
    assert.strictEqual(r.broadcast.code, created.code);
    assert.ok(r.broadcast.events.some((e) => e.type === "player_ready" && e.seat === 0));
});

test("a malformed message yields an error reply, not a throw", () => {
    const c = ctx();
    const r = handleClientMessage({ ...c, message: { type: "create_room" } });
    assert.strictEqual(r.reply.type, "error");
});

// ----- redactStateFor ---------------------------------------------------------

// A hand-built authoritative snapshot mirroring roomManager.getState output,
// with a game in the meld phase: team_A (seats 0,2) at 24 (shown), team_B
// (seats 1,3) at 8 (hidden).
function meldPhaseSnapshot() {
    const seatMeld = (total) => ({ total, breakdown: [{ name: "x", points: total }] });
    return {
        code: "ABCD",
        phase: "playing",
        paused: false,
        winner: null,
        seats: [
            { seat: 0, name: "A", connected: true },
            { seat: 1, name: "B", connected: true },
            { seat: 2, name: "C", connected: true },
            { seat: 3, name: "D", connected: true }
        ],
        game: {
            phase: "meld",
            dealer: 0, currentPlayer: null, declarer: 1, dealerNoMarriage: false,
            scores: { team_A: 0, team_B: 0 }, targetScore: 500,
            ready: [false, false, false, false],
            bidding: { currentBid: 50, highBidder: 1, passed: [false, false, false, false], trump: "D" },
            tricks: { currentTrick: [], ledSuit: null, completed: [], counters: { team_A: 0, team_B: 0 } },
            lastHandResult: null,
            seats: [
                { name: "A", hand: ["KC", "QC"] },
                { name: "B", hand: ["KD", "QD"] },
                { name: "C", hand: ["KS", "QS"] },
                { name: "D", hand: ["KH", "QH"] }
            ],
            meld: {
                teamTotals: { team_A: 24, team_B: 8 },
                declared: [seatMeld(12), seatMeld(4), seatMeld(12), seatMeld(4)]
            }
        }
    };
}

test("redaction shows your own cards and only counts for others", () => {
    const view = redactStateFor(meldPhaseSnapshot(), 0);
    assert.deepEqual(view.game.seats[0].hand, ["KC", "QC"]);   // your hand, in full
    assert.strictEqual(view.game.seats[1].hand, undefined);    // opponents: no cards
    assert.strictEqual(view.game.seats[1].handCount, 2);       // just a count
    assert.strictEqual(view.you, 0);
});

test("redaction shows a team's meld at/above the threshold and hides it below", () => {
    // Seat 0 is on team_A (24, shown). team_B is at 8 (hidden).
    const view = redactStateFor(meldPhaseSnapshot(), 0);
    assert.strictEqual(view.game.meld.teamTotals.team_A, 24);
    assert.strictEqual(view.game.meld.teamTotals.team_B, null);

    // Shown team's breakdowns are visible to everyone; hidden team's are not...
    assert.ok(view.game.meld.declared[0]);   // own team, shown
    assert.ok(view.game.meld.declared[2]);   // partner, team shown
    assert.strictEqual(view.game.meld.declared[1], null);   // opponent, team hidden
    assert.strictEqual(view.game.meld.declared[3], null);
});

test("you always see your own meld breakdown even when your team is below the threshold", () => {
    // Seat 1 is on team_B (8, hidden). They still see their own breakdown,
    // but not their partner's (seat 3), and not the combined total.
    const view = redactStateFor(meldPhaseSnapshot(), 1);
    assert.ok(view.game.meld.declared[1]);                   // own breakdown
    assert.strictEqual(view.game.meld.declared[3], null);    // partner hidden (team < 20)
    assert.strictEqual(view.game.meld.teamTotals.team_B, null);
});

// ----- redactEvents -----------------------------------------------------------

test("redactEvents gates meld values but leaves public events untouched", () => {
    const events = [
        { type: "meld_computed", teamTotals: { team_A: 24, team_B: 8 } },
        { type: "card_played", seat: 0, card: "AS" },
        { type: "hand_scored", result: { meld: { team_A: 8, team_B: 50 }, deltas: { team_A: -50, team_B: 50 } } }
    ];
    const redacted = redactEvents(events);
    assert.deepEqual(redacted[0].teamTotals, { team_A: 24, team_B: null });
    assert.deepEqual(redacted[1], { type: "card_played", seat: 0, card: "AS" });
    assert.deepEqual(redacted[2].result.meld, { team_A: null, team_B: 50 });
    assert.deepEqual(redacted[2].result.deltas, { team_A: -50, team_B: 50 });   // deltas untouched
});
