import { test } from "node:test";
import assert from "node:assert/strict";
import { createRoomManager } from "../src/room.js";

// Short windows so time-based tests use small, readable timestamps.
function newManager(overrides = {}) {
    return createRoomManager({
        maxRooms: 100,
        maxRoomsPerOwner: 3,
        reconnectWindowMs: 1000,
        idleTtlMs: 5000,
        ...overrides
    });
}

// Create a full 4-seat room (creator at seat 0) and return its code + tokens.
function fillRoom(mgr, now = 0) {
    const created = mgr.createRoom({ name: "A", ownerKey: "owner-1", now });
    const tokens = [created.token];
    const names = ["", "B", "C", "D"];
    for (let seat = 1; seat < 4; seat++) {
        tokens[seat] = mgr.joinRoom({ code: created.code, name: names[seat], seat, now }).token;
    }
    return { code: created.code, tokens };
}

// ----- Room creation and joining ----------------------------------------------

test("createRoom seats the creator and returns a readable code + token", () => {
    const mgr = newManager();
    const r = mgr.createRoom({ name: "Alice", ownerKey: "o", now: 0 });
    assert.match(r.code, /^[A-Z2-9]{4}$/);
    assert.ok(r.token.length > 0);
    assert.strictEqual(r.seat, 0);

    const st = mgr.getState(r.code);
    assert.strictEqual(st.phase, "lobby");
    assert.strictEqual(st.seats[0].name, "Alice");
    assert.strictEqual(st.seats[1], null);
});

test("joinRoom places a player in the chosen seat and rejects taken/unknown", () => {
    const mgr = newManager();
    const r = mgr.createRoom({ name: "A", now: 0 });

    const j = mgr.joinRoom({ code: r.code, name: "B", seat: 2, now: 1 });
    assert.strictEqual(j.seat, 2);
    assert.ok(j.token);

    assert.match(mgr.joinRoom({ code: r.code, name: "C", seat: 2, now: 2 }).error, /taken/);
    assert.match(mgr.joinRoom({ code: "ZZZZ", name: "C", seat: 1, now: 2 }).error, /not found/);
});

test("the game begins once all four seats are filled", () => {
    const mgr = newManager();
    const { code } = fillRoom(mgr);
    const st = mgr.getState(code);
    assert.strictEqual(st.phase, "playing");
    assert.strictEqual(st.game.phase, "dealing");
    assert.deepEqual(st.game.seats.map((s) => s.name), ["A", "B", "C", "D"]);
});

test("joining a game that has already started is rejected", () => {
    const mgr = newManager();
    const { code } = fillRoom(mgr);
    assert.match(mgr.joinRoom({ code, name: "E", seat: 0, now: 5 }).error, /already started/);
});

test("display names are sanitized (control chars stripped, length capped)", () => {
    const mgr = newManager();
    const dirty = "  Bad" + String.fromCharCode(0) + "Name" + String.fromCharCode(7) + "  ";
    const r = mgr.createRoom({ name: dirty, now: 0 });
    assert.strictEqual(mgr.getState(r.code).seats[0].name, "BadName");

    const long = mgr.createRoom({ name: "x".repeat(50), now: 0 });
    assert.strictEqual(mgr.getState(long.code).seats[0].name.length, 20);
});

// ----- Action routing ---------------------------------------------------------

test("applyAction routes to the engine and reports events", () => {
    const mgr = newManager();
    const { code, tokens } = fillRoom(mgr);
    const r = mgr.applyAction({ code, token: tokens[0], action: { actor: 0, type: "start_game" }, now: 1 });
    assert.ok(Array.isArray(r.events));
    assert.ok(r.events.some((e) => e.type === "player_ready"));
});

test("you can only act as your own seat", () => {
    const mgr = newManager();
    const { code, tokens } = fillRoom(mgr);
    const r = mgr.applyAction({ code, token: tokens[0], action: { actor: 1, type: "start_game" }, now: 1 });
    assert.match(r.error, /your own seat/);
});

test("four start_game actions through the manager deal the hand", () => {
    const mgr = newManager();
    const { code, tokens } = fillRoom(mgr);
    for (let seat = 0; seat < 4; seat++) {
        mgr.applyAction({ code, token: tokens[seat], action: { actor: seat, type: "start_game" }, now: seat });
    }
    assert.strictEqual(mgr.getState(code).game.phase, "bidding");
});

test("player errors from the engine pass through without changing state", () => {
    const mgr = newManager();
    const { code, tokens } = fillRoom(mgr);
    // bidding/play actions aren't valid in the dealing phase
    const r = mgr.applyAction({ code, token: tokens[0], action: { actor: 0, type: "bid", amount: 50 }, now: 1 });
    assert.match(r.error, /not valid during phase/);
    assert.strictEqual(mgr.getState(code).game.phase, "dealing");
});

// ----- Disconnect / reconnect / forfeit ---------------------------------------

test("disconnect pauses the game, blocks actions, and reconnect resumes it", () => {
    const mgr = newManager();
    const { code, tokens } = fillRoom(mgr);

    mgr.disconnect({ code, token: tokens[1], now: 10 });
    assert.strictEqual(mgr.getState(code).paused, true);
    assert.match(
        mgr.applyAction({ code, token: tokens[0], action: { actor: 0, type: "start_game" }, now: 11 }).error,
        /paused/
    );

    const rc = mgr.reconnect({ code, token: tokens[1], now: 12 });
    assert.strictEqual(rc.seat, 1);
    assert.strictEqual(mgr.getState(code).paused, false);
});

test("reconnect with an unknown token is rejected", () => {
    const mgr = newManager();
    const { code } = fillRoom(mgr);
    assert.match(mgr.reconnect({ code, token: "deadbeef", now: 1 }).error, /invalid reconnect token/);
});

test("disconnecting in the lobby frees the seat for reuse", () => {
    const mgr = newManager();
    const r = mgr.createRoom({ name: "A", now: 0 });
    const j = mgr.joinRoom({ code: r.code, name: "B", seat: 1, now: 1 });

    mgr.disconnect({ code: r.code, token: j.token, now: 2 });
    assert.strictEqual(mgr.getState(r.code).seats[1], null);
    assert.ok(mgr.joinRoom({ code: r.code, name: "C", seat: 1, now: 3 }).token);
});

test("a lobby that empties out is removed", () => {
    const mgr = newManager();
    const r = mgr.createRoom({ name: "A", now: 0 });
    mgr.disconnect({ code: r.code, token: r.token, now: 1 });
    assert.strictEqual(mgr.getState(r.code), null);
});

// ----- sweep: forfeits and idle expiry ----------------------------------------

test("sweep forfeits the disconnected player's team after the window", () => {
    const mgr = newManager({ reconnectWindowMs: 1000, idleTtlMs: 100000 });
    const { code, tokens } = fillRoom(mgr, 0);

    mgr.disconnect({ code, token: tokens[1], now: 100 });   // seat 1 = team_B
    assert.deepEqual(mgr.sweep(500).forfeited, []);          // still within the window

    const res = mgr.sweep(100 + 1000);                       // window elapsed
    assert.strictEqual(res.forfeited.length, 1);
    assert.strictEqual(res.forfeited[0].losingTeam, "team_B");
    assert.strictEqual(res.forfeited[0].winner, "team_A");

    const st = mgr.getState(code);
    assert.strictEqual(st.phase, "finished");
    assert.strictEqual(st.winner, "team_A");
});

test("a forfeited game no longer accepts actions", () => {
    const mgr = newManager({ reconnectWindowMs: 1000, idleTtlMs: 100000 });
    const { code, tokens } = fillRoom(mgr, 0);
    mgr.disconnect({ code, token: tokens[1], now: 100 });
    mgr.sweep(2000);
    assert.match(
        mgr.applyAction({ code, token: tokens[0], action: { actor: 0, type: "start_game" }, now: 2001 }).error,
        /no game is in progress/
    );
});

test("sweep expires idle rooms", () => {
    const mgr = newManager({ idleTtlMs: 1000 });
    const r = mgr.createRoom({ name: "A", now: 0 });
    const res = mgr.sweep(1000);
    assert.deepEqual(res.expired, [r.code]);
    assert.strictEqual(mgr.getState(r.code), null);
});

// ----- Leaving / ending a game ------------------------------------------------

test("leaveRoom destroys the room for everyone", () => {
    const mgr = newManager();
    const { code, tokens } = fillRoom(mgr, 0);
    const res = mgr.leaveRoom({ code, token: tokens[2] });
    assert.deepEqual(res, { ok: true });
    assert.strictEqual(mgr.getState(code), null);
});

test("leaveRoom frees the owner's active-room cap immediately", () => {
    const mgr = newManager({ maxRoomsPerOwner: 1 });
    const first = mgr.createRoom({ name: "A", ownerKey: "ip", now: 0 });
    assert.match(mgr.createRoom({ name: "B", ownerKey: "ip", now: 0 }).error, /too many/);
    mgr.leaveRoom({ code: first.code, token: first.token });
    assert.ok(mgr.createRoom({ name: "B", ownerKey: "ip", now: 0 }).code);
});

test("leaveRoom rejects an unknown room or a non-member token", () => {
    const mgr = newManager();
    const { code } = fillRoom(mgr, 0);
    assert.match(mgr.leaveRoom({ code: "ZZZZ", token: "x" }).error, /not found/);
    assert.match(mgr.leaveRoom({ code, token: "not-a-real-token" }).error, /not seated/);
});

// ----- Caps -------------------------------------------------------------------

test("createRoom respects the global room cap", () => {
    const mgr = newManager({ maxRooms: 1 });
    mgr.createRoom({ name: "A", now: 0 });
    assert.match(mgr.createRoom({ name: "B", now: 0 }).error, /capacity/);
});

test("createRoom respects the per-owner active-room cap", () => {
    const mgr = newManager({ maxRoomsPerOwner: 2 });
    mgr.createRoom({ name: "A", ownerKey: "ip1", now: 0 });
    mgr.createRoom({ name: "A", ownerKey: "ip1", now: 0 });
    assert.match(mgr.createRoom({ name: "A", ownerKey: "ip1", now: 0 }).error, /too many/);
    assert.ok(mgr.createRoom({ name: "A", ownerKey: "ip2", now: 0 }).code);   // a different owner is fine
});

// ----- Security ---------------------------------------------------------------

test("getState never exposes reconnect tokens", () => {
    const mgr = newManager();
    const { code } = fillRoom(mgr);
    for (const seat of mgr.getState(code).seats) {
        assert.ok(!("token" in seat));
    }
});
