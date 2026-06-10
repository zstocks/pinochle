// Layer 2: the room manager — in-memory sessions over the pure rules engine.
//
// Knows about rooms, seats, reconnect tokens, lobby state, idle TTLs, and
// forfeits. It routes validated actions to engine.apply and stores the result.
// It knows nothing about the wire (no sockets, no IP semantics — the transport
// supplies an opaque `ownerKey` for the per-creator cap) and nothing about game
// rules (it never inspects cards or scores; it only calls the engine).
//
// Time is injected, never read from the system clock: every time-dependent
// method takes an explicit `now` (epoch ms) and `sweep(now)` reports which rooms
// forfeited or expired. The real setInterval that drives sweep lives at the I/O
// edge (Layer 3). This keeps the whole module unit-testable with no fake timers.
//
// Redaction of personalized views (hiding other players' hands, hiding a team's
// sub-20 meld) is deliberately NOT done here — getState returns the authoritative
// state and Layer 3 builds each client's view. Tokens are the one secret this
// layer holds; they are never included in getState output.

import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createInitialState, teamOf } from "./state.js";
import { apply } from "./engine.js";

const NUM_SEATS = 4;

const DEFAULT_MAX_ROOMS = 100;
const DEFAULT_MAX_ROOMS_PER_OWNER = 3;
const DEFAULT_RECONNECT_WINDOW_MS = 5 * 60 * 1000;   // game pauses this long before forfeit
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;          // no activity this long → garbage-collected

const ROOM_CODE_LENGTH = 4;
// Unambiguous alphabet — no 0/O/1/I/L, so codes are easy to read aloud and type.
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const MAX_CODE_ATTEMPTS = 100;

const TOKEN_BYTES = 16;          // 128 bits of entropy per reconnect token
const MAX_NAME_LENGTH = 20;
// Strip ASCII control characters (U+0000–U+001F and U+007F). Built from an
// escaped string so no literal control bytes appear in this source file.
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]", "g");

// ----- Factory ----------------------------------------------------------------

export function createRoomManager(config = {}) {
    const maxRooms = config.maxRooms ?? DEFAULT_MAX_ROOMS;
    const maxRoomsPerOwner = config.maxRoomsPerOwner ?? DEFAULT_MAX_ROOMS_PER_OWNER;
    const reconnectWindowMs = config.reconnectWindowMs ?? DEFAULT_RECONNECT_WINDOW_MS;
    const idleTtlMs = config.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;

    const rooms = new Map();   // code -> room

    // --- Room lifecycle ---

    function createRoom({ name, ownerKey = null, seat = 0, now }) {
        if (rooms.size >= maxRooms) {
            return { error: "the server is at capacity, please try again later" };
        }
        if (!isValidSeat(seat)) return { error: "invalid seat" };
        if (ownerKey !== null && countActiveRooms(ownerKey) >= maxRoomsPerOwner) {
            return { error: "you already have too many active rooms" };
        }

        const code = generateCode(rooms);
        const seats = [null, null, null, null];
        const token = newToken();
        seats[seat] = newSeat(name, token);

        rooms.set(code, {
            code,
            phase: "lobby",          // lobby -> playing -> finished (or abandoned)
            createdAt: now,
            lastActivityAt: now,
            paused: false,
            seats,
            gameState: null,         // created once the room fills
            winner: null,
            ownerKey
        });
        return { code, token, seat };
    }

    function joinRoom({ code, name, seat, now }) {
        const room = rooms.get(code);
        if (!room) return { error: "room not found" };
        if (room.phase !== "lobby") return { error: "this game has already started" };
        if (!isValidSeat(seat)) return { error: "invalid seat" };
        if (room.seats[seat]) return { error: "that seat is taken" };

        const token = newToken();
        room.seats[seat] = newSeat(name, token);
        room.lastActivityAt = now;

        // Last seat filled: stand up the engine state and begin play.
        if (room.seats.every(Boolean)) {
            room.gameState = createInitialState(room.seats.map((s) => s.name));
            room.phase = "playing";
        }
        return { token, seat, started: room.phase === "playing" };
    }

    // --- Connection state ---

    function disconnect({ code, token, now }) {
        const room = rooms.get(code);
        if (!room) return { error: "room not found" };
        const seat = seatByToken(room, token);
        if (seat === -1) return { error: "invalid token" };

        room.lastActivityAt = now;

        // In the lobby there is no game to pause — just free the seat so others
        // can take it, and drop the room entirely if it empties out.
        if (room.phase === "lobby") {
            room.seats[seat] = null;
            if (room.seats.every((s) => s === null)) rooms.delete(code);
            return { seat, freed: true };
        }

        room.seats[seat].connected = false;
        room.seats[seat].disconnectedAt = now;
        room.paused = isPaused(room);
        return { seat, freed: false };
    }

    function reconnect({ code, token, now }) {
        const room = rooms.get(code);
        if (!room) return { error: "room not found" };
        const seat = seatByToken(room, token);
        if (seat === -1) return { error: "invalid reconnect token" };

        room.seats[seat].connected = true;
        room.seats[seat].disconnectedAt = null;
        room.paused = isPaused(room);
        room.lastActivityAt = now;
        return { seat };
    }

    // --- Action routing ---

    function applyAction({ code, token, action, now }) {
        const room = rooms.get(code);
        if (!room) return { error: "room not found" };
        if (room.phase !== "playing") return { error: "no game is in progress" };
        if (room.paused) return { error: "the game is paused, waiting for a player to reconnect" };

        const seat = seatByToken(room, token);
        if (seat === -1) return { error: "you are not seated in this room" };
        // Server-authoritative identity: you can only act as the seat you hold.
        if (action.actor !== seat) return { error: "you can only act as your own seat" };

        // engine.apply throws on malformed actions (programmer errors). Layer 3
        // validates the wire schema before calling and wraps this in a try/catch,
        // so a bad action can't take down the process.
        const result = apply(room.gameState, action);
        if (result.error) return { error: result.error };

        room.gameState = result.state;
        room.lastActivityAt = now;
        if (result.state.phase === "complete") {
            room.phase = "finished";
            room.winner = result.state.winner;
        }
        return { events: result.events };
    }

    // --- Reads ---

    // Authoritative snapshot for Layer 3 to redact into per-player views. Never
    // includes tokens.
    function getState(code) {
        const room = rooms.get(code);
        if (!room) return null;
        return {
            code: room.code,
            phase: room.phase,
            paused: room.paused,
            winner: room.winner,
            seats: room.seats.map((s, i) =>
                s ? { seat: i, name: s.name, connected: s.connected } : null
            ),
            game: room.gameState
        };
    }

    // --- Periodic maintenance (called by the transport on a timer) ---

    function sweep(now) {
        const forfeited = [];
        const expired = [];

        for (const [code, room] of rooms) {
            if (room.phase === "playing" && room.paused) {
                const losingSeat = expiredDisconnectSeat(room, now, reconnectWindowMs);
                if (losingSeat !== -1) {
                    const losingTeam = teamOf(losingSeat);
                    const winner = losingTeam === "team_A" ? "team_B" : "team_A";
                    room.phase = "finished";
                    room.winner = winner;
                    room.paused = false;
                    forfeited.push({ code, losingTeam, winner });
                    continue;   // forfeited this sweep; don't also idle-expire it
                }
            }
            if (now - room.lastActivityAt >= idleTtlMs) {
                expired.push(code);
            }
        }

        for (const code of expired) rooms.delete(code);
        return { forfeited, expired };
    }

    return {
        createRoom,
        joinRoom,
        disconnect,
        reconnect,
        applyAction,
        getState,
        sweep,
        roomCount: () => rooms.size
    };

    // --- Internal helpers (closures over `rooms` / config) ---

    function countActiveRooms(ownerKey) {
        let count = 0;
        for (const room of rooms.values()) {
            if (room.ownerKey === ownerKey && (room.phase === "lobby" || room.phase === "playing")) {
                count++;
            }
        }
        return count;
    }
}

// ----- Pure helpers (no room-map dependency) ----------------------------------

function isValidSeat(seat) {
    return Number.isInteger(seat) && seat >= 0 && seat < NUM_SEATS;
}

function newSeat(name, token) {
    return { name: sanitizeName(name), token, connected: true, disconnectedAt: null };
}

function newToken() {
    return randomBytes(TOKEN_BYTES).toString("hex");
}

// A room is paused whenever a game is in progress and any seated player is
// currently disconnected.
function isPaused(room) {
    return room.phase === "playing" && room.seats.some((s) => s && !s.connected);
}

// The seat of the longest-disconnected player past the reconnect window, or -1.
// Earliest disconnect triggers the forfeit if more than one is over the line.
function expiredDisconnectSeat(room, now, windowMs) {
    let worstSeat = -1;
    let earliest = Infinity;
    for (let i = 0; i < NUM_SEATS; i++) {
        const s = room.seats[i];
        if (s && !s.connected && s.disconnectedAt !== null && now - s.disconnectedAt >= windowMs) {
            if (s.disconnectedAt < earliest) {
                earliest = s.disconnectedAt;
                worstSeat = i;
            }
        }
    }
    return worstSeat;
}

function seatByToken(room, token) {
    for (let i = 0; i < NUM_SEATS; i++) {
        if (room.seats[i] && tokensMatch(room.seats[i].token, token)) return i;
    }
    return -1;
}

// Constant-time comparison so a reconnect token can't be recovered by timing.
function tokensMatch(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
}

// Length-cap and strip control characters. Rendering as text (never HTML) is the
// frontend's job; this just keeps stored names sane.
function sanitizeName(name) {
    if (typeof name !== "string") return "Player";
    const cleaned = name.replace(CONTROL_CHARS, "").trim().slice(0, MAX_NAME_LENGTH);
    return cleaned.length > 0 ? cleaned : "Player";
}

function generateCode(rooms) {
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
        let code = "";
        for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
            code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
        }
        if (!rooms.has(code)) return code;
    }
    throw new Error("unable to generate a unique room code");
}
