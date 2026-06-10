// Layer 3, pure core: message protocol — validation, dispatch, and redaction.
//
// This module has NO I/O. It is the transport-agnostic brain of the server:
//   - validateMessage: strict schema check on an incoming client message
//   - handleClientMessage: turn a validated message into side-effect intents
//     (a direct reply, an updated session, and/or a room broadcast)
//   - redactStateFor / redactEvents: build the per-player view of a room,
//     hiding other players' cards and any team's meld below the show threshold
//
// server.js wires these to real sockets. Keeping them pure means the security-
// critical bits (what each client is allowed to see, what messages are accepted)
// are unit-tested in isolation with no network.

import { teamOf } from "./state.js";

export const PROTOCOL_VERSION = 1;

// A team's meld is public only once it reaches the show threshold (rules.md §6);
// below it, opponents must not even learn whether it was 0 or 19.
const MIN_MELD_TO_SHOW = 20;

// ----- Incoming message schemas -----------------------------------------------
//
// Every client message is { protocol_version, type, ...fields }. Validation is
// strict: unknown types, unknown fields, missing fields, and wrong types are all
// rejected before anything reaches the room manager.

const MESSAGE_SCHEMAS = {
    create_room: { name: "string", "seat?": "int" },
    join_room: { code: "string", name: "string", seat: "int" },
    reconnect: { code: "string", token: "string" },
    action: { action: "object" }
};

// Per-action-type parameter schemas. The client never sends `actor` — the server
// injects it from the socket's session, so a client can't act as another seat.
const ACTION_SCHEMAS = {
    start_game: {},
    pass: {},
    acknowledge_meld: {},
    bid: { amount: "int" },
    declare_trump: { suit: "string" },
    play_card: { card: "string" }
};

// ----- Validation -------------------------------------------------------------

export function validateMessage(message) {
    if (!isPlainObject(message)) return fail("message must be an object");
    if (message.protocol_version !== PROTOCOL_VERSION) {
        return fail(`unsupported protocol_version (expected ${PROTOCOL_VERSION})`);
    }
    if (typeof message.type !== "string" || !(message.type in MESSAGE_SCHEMAS)) {
        return fail(`unknown message type "${message.type}"`);
    }

    const schemaError = checkAgainstSchema(message, MESSAGE_SCHEMAS[message.type], ["protocol_version", "type"]);
    if (schemaError) return fail(schemaError);

    if (message.type === "action") {
        const actionError = validateAction(message.action);
        if (actionError) return fail(actionError);
    }
    return { ok: true };
}

function validateAction(action) {
    if (!isPlainObject(action)) return "action must be an object";
    if (typeof action.type !== "string" || !(action.type in ACTION_SCHEMAS)) {
        return `unknown action type "${action.type}"`;
    }
    return checkAgainstSchema(action, ACTION_SCHEMAS[action.type], ["type"]);
}

// Verify an object against a {field: kind} schema. `kind` may end in "?" via a
// "field?" key to mark it optional. Extra (unexpected) fields are rejected.
// Returns an error string, or null if valid.
function checkAgainstSchema(obj, schema, alwaysAllowed) {
    const allowed = new Set(alwaysAllowed);
    for (const rawKey of Object.keys(schema)) {
        const key = rawKey.endsWith("?") ? rawKey.slice(0, -1) : rawKey;
        const kind = schema[rawKey];
        const optional = rawKey.endsWith("?");
        allowed.add(key);

        if (!(key in obj)) {
            if (!optional) return `missing field "${key}"`;
            continue;
        }
        if (!isKind(obj[key], kind)) return `field "${key}" must be ${kind}`;
    }
    for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) return `unexpected field "${key}"`;
    }
    return null;
}

function isKind(value, kind) {
    if (kind === "string") return typeof value === "string";
    if (kind === "int") return Number.isInteger(value);
    if (kind === "object") return isPlainObject(value);
    return false;
}

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ----- Dispatch ---------------------------------------------------------------
//
// Returns intents for the glue to act on:
//   { reply, session, broadcast }
//   - reply:     a message to send back to this sender (or undefined)
//   - session:   the sender's new session, if it changed (or undefined)
//   - broadcast: { code, events } telling the glue to push redacted state to all
//                sockets in that room (or undefined)

export function handleClientMessage({ session, message, roomManager, ownerKey, now }) {
    const valid = validateMessage(message);
    if (!valid.ok) return { reply: makeError(valid.error) };

    switch (message.type) {
        case "create_room": {
            const res = roomManager.createRoom({ name: message.name, ownerKey, seat: message.seat ?? 0, now });
            if (res.error) return { reply: makeError(res.error) };
            return {
                reply: makeJoined(res.code, res.token, res.seat),
                session: { code: res.code, seat: res.seat, token: res.token },
                broadcast: { code: res.code, events: [] }
            };
        }
        case "join_room": {
            const res = roomManager.joinRoom({ code: message.code, name: message.name, seat: message.seat, now });
            if (res.error) return { reply: makeError(res.error) };
            return {
                reply: makeJoined(message.code, res.token, res.seat),
                session: { code: message.code, seat: res.seat, token: res.token },
                broadcast: { code: message.code, events: [] }
            };
        }
        case "reconnect": {
            const res = roomManager.reconnect({ code: message.code, token: message.token, now });
            if (res.error) return { reply: makeError(res.error) };
            return {
                reply: makeJoined(message.code, message.token, res.seat),
                session: { code: message.code, seat: res.seat, token: message.token },
                broadcast: { code: message.code, events: [] }
            };
        }
        case "action": {
            if (!session) return { reply: makeError("you are not in a room") };
            // Inject actor from the session — never trust a client-supplied seat.
            const action = { ...message.action, actor: session.seat };
            const res = roomManager.applyAction({ code: session.code, token: session.token, action, now });
            if (res.error) return { reply: makeError(res.error) };
            return { broadcast: { code: session.code, events: res.events } };
        }
    }
}

// ----- Redaction --------------------------------------------------------------

// Build the view a single seat is allowed to see from the room manager's
// authoritative snapshot. Hides other players' cards (counts only) and any team's
// meld that is below the show threshold.
export function redactStateFor(fullState, seat) {
    if (!fullState) return null;
    return {
        code: fullState.code,
        phase: fullState.phase,
        paused: fullState.paused,
        winner: fullState.winner,
        you: seat,
        players: fullState.seats,   // {seat,name,connected}|null — already token-free
        game: fullState.game ? redactGame(fullState.game, seat) : null
    };
}

function redactGame(game, seat) {
    return {
        phase: game.phase,
        dealer: game.dealer,
        currentPlayer: game.currentPlayer,
        declarer: game.declarer,
        dealerNoMarriage: game.dealerNoMarriage,
        scores: game.scores,
        targetScore: game.targetScore,
        ready: game.ready,
        bidding: game.bidding,        // currentBid/highBidder/passed/trump are all public
        tricks: game.tricks,          // every played card is public
        lastHandResult: redactHandResult(game.lastHandResult),
        seats: game.seats.map((s, i) => ({
            handCount: s.hand.length,
            // Your own cards in full; everyone else only as a count.
            ...(i === seat ? { hand: s.hand } : {})
        })),
        meld: {
            teamTotals: gateTeamTotals(game.meld.teamTotals),
            // Your own meld breakdown always; a teammate's/opponent's only once
            // their team total is at the show threshold.
            declared: game.meld.declared.map((d, i) =>
                (i === seat || isTeamShown(game.meld.teamTotals, i)) ? d : null
            )
        }
    };
}

function redactHandResult(result) {
    if (!result) return null;
    return { ...result, meld: gateTeamTotals(result.meld) };
}

// Redact the engine's event list. The only events that carry meld values are
// meld_computed and hand_scored; gate those by the show threshold. The gating is
// global (a team's total is public iff ≥ threshold), so the redacted list is the
// same for every recipient.
export function redactEvents(events) {
    return events.map((event) => {
        if (event.type === "meld_computed") {
            return { ...event, teamTotals: gateTeamTotals(event.teamTotals) };
        }
        if (event.type === "hand_scored") {
            return { ...event, result: { ...event.result, meld: gateTeamTotals(event.result.meld) } };
        }
        return event;
    });
}

// Replace a team's total with null unless it has reached the show threshold.
function gateTeamTotals(teamTotals) {
    return {
        team_A: teamTotals.team_A >= MIN_MELD_TO_SHOW ? teamTotals.team_A : null,
        team_B: teamTotals.team_B >= MIN_MELD_TO_SHOW ? teamTotals.team_B : null
    };
}

function isTeamShown(teamTotals, seatIndex) {
    return teamTotals[teamOf(seatIndex)] >= MIN_MELD_TO_SHOW;
}

// ----- Message builders -------------------------------------------------------

export function makeError(message) {
    return { protocol_version: PROTOCOL_VERSION, type: "error", message };
}

export function makeJoined(code, token, seat) {
    return { protocol_version: PROTOCOL_VERSION, type: "joined", code, token, seat };
}

export function makeState(view, events) {
    return { protocol_version: PROTOCOL_VERSION, type: "state", view, events };
}

function fail(error) {
    return { ok: false, error };
}
