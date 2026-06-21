// Layer 3, the glue: HTTP + WebSocket transport.
//
// Deliberately thin. All decisions about what messages are valid and what each
// client may see live in the pure protocol core (protocol.js) and the room
// manager (room.js); this file only wires real sockets to them and enforces the
// network-edge defenses: per-IP connection caps, per-socket rate limiting, a
// message size cap, heartbeats, and the timer that drives roomManager.sweep.
//
// TLS is terminated by nginx; this process speaks plain HTTP/WS bound to
// 127.0.0.1 (see CLAUDE.md deployment notes). Client IP is read from
// X-Forwarded-For (nginx is trusted) and used as the per-creator cap key.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";

import { createRoomManager } from "./room.js";
import {
    handleClientMessage,
    redactStateFor,
    redactEvents,
    makeState,
    makeError,
    makeRoomClosed
} from "./protocol.js";

const MAX_MESSAGE_BYTES = 4 * 1024;     // hard cap on a single inbound frame
const MAX_CONN_PER_IP = 10;
const RATE_CAPACITY = 10;               // burst of messages allowed
const RATE_REFILL_PER_SEC = 10;         // sustained messages/sec
const PING_INTERVAL_MS = 30_000;        // heartbeat to detect dead (e.g. mobile) sockets
const SWEEP_INTERVAL_MS = 30_000;       // forfeit/idle maintenance cadence

const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon"
};

// ----- Server factory ---------------------------------------------------------

export function createGameServer(options = {}) {
    const roomManager = options.roomManager ?? createRoomManager(options.roomConfig);
    const publicDir = path.resolve(options.publicDir ?? "public");
    const now = () => options.now?.() ?? Date.now();

    const conns = new Map();   // ws -> { ip, session, bucket, alive }

    const httpServer = http.createServer((req, res) => serveStatic(req, res, publicDir));
    const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });

    wss.on("connection", (ws, req) => {
        const ip = clientIp(req);
        if (countConnectionsFromIp(conns, ip) >= MAX_CONN_PER_IP) {
            ws.close(1008, "too many connections");
            return;
        }
        conns.set(ws, { ip, session: null, bucket: newBucket(now()), alive: true });

        ws.on("pong", () => { const c = conns.get(ws); if (c) c.alive = true; });
        ws.on("error", () => {});   // a socket error just means it's going away
        ws.on("close", () => onClose(ws));
        ws.on("message", (data) => onMessage(ws, data));
    });

    function onMessage(ws, data) {
        const conn = conns.get(ws);
        if (!conn) return;

        if (!takeToken(conn.bucket, now())) {
            send(ws, makeError("rate limit exceeded, slow down"));
            return;
        }

        let message;
        try {
            message = JSON.parse(data.toString());
        } catch {
            send(ws, makeError("message is not valid JSON"));
            return;
        }

        let result;
        try {
            result = handleClientMessage({
                session: conn.session,
                message,
                roomManager,
                ownerKey: conn.ip,
                now: now()
            });
        } catch (err) {
            // The protocol core returns player errors; a throw here is a
            // programmer error (e.g. an unvalidated path). Don't take down the
            // process — log it and tell the client something generic.
            console.error("unexpected handler error:", err);
            send(ws, makeError("internal server error"));
            return;
        }

        if (result.session !== undefined) conn.session = result.session;
        if (result.reply) send(ws, result.reply);
        if (result.broadcast) broadcastRoom(result.broadcast.code, result.broadcast.events);
        if (result.closeRoom) closeRoomForAll(result.closeRoom.code);
    }

    // A player ended the game: the room is already gone from the manager. Tell
    // everyone still pointed at it and clear their session so they don't try to
    // reconnect to a room that no longer exists. Sockets stay open so they can
    // start or join a new game immediately.
    function closeRoomForAll(code) {
        for (const [ws, conn] of conns) {
            if (conn.session?.code === code) {
                send(ws, makeRoomClosed("A player ended the game."));
                conn.session = null;
            }
        }
    }

    function onClose(ws) {
        const conn = conns.get(ws);
        conns.delete(ws);
        if (!conn?.session) return;
        const { code, token } = conn.session;
        roomManager.disconnect({ code, token, now: now() });
        broadcastRoom(code, []);   // remaining players see the pause / freed seat
    }

    // Push each connected player in `code` their own redacted view plus the
    // (already gated) events from the change that triggered the broadcast.
    function broadcastRoom(code, events) {
        const full = roomManager.getState(code);
        if (!full) return;
        const redactedEvents = redactEvents(events);
        for (const [ws, conn] of conns) {
            if (conn.session?.code === code) {
                send(ws, makeState(redactStateFor(full, conn.session.seat), redactedEvents));
            }
        }
    }

    // --- Maintenance timers (unref'd so they never hold the process open) ---

    const sweepTimer = setInterval(() => runSweep(), SWEEP_INTERVAL_MS);
    const pingTimer = setInterval(() => runHeartbeat(), PING_INTERVAL_MS);
    sweepTimer.unref?.();
    pingTimer.unref?.();

    function runSweep() {
        const { forfeited, expired } = roomManager.sweep(now());
        for (const f of forfeited) {
            broadcastRoom(f.code, [{ type: "game_over", winner: f.winner, reason: "forfeit" }]);
        }
        for (const code of expired) {
            for (const [ws, conn] of conns) {
                if (conn.session?.code === code) {
                    send(ws, makeError("room closed due to inactivity"));
                    ws.close(1000, "room closed");
                }
            }
        }
    }

    function runHeartbeat() {
        for (const [ws, conn] of conns) {
            if (!conn.alive) { ws.terminate(); continue; }
            conn.alive = false;
            ws.ping();
        }
    }

    function close() {
        clearInterval(sweepTimer);
        clearInterval(pingTimer);
        for (const ws of conns.keys()) ws.terminate();
        conns.clear();
        return new Promise((resolve) => {
            wss.close(() => httpServer.close(() => resolve()));
        });
    }

    return { httpServer, wss, roomManager, close, runSweep, runHeartbeat };
}

// ----- Helpers ----------------------------------------------------------------

function send(ws, message) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function clientIp(req) {
    // Behind nginx the socket address is always 127.0.0.1, so trust the proxy's
    // forwarded headers for the real client IP (used for the per-IP caps).
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0].trim();
    const xRealIp = req.headers["x-real-ip"];
    if (typeof xRealIp === "string" && xRealIp.length > 0) return xRealIp.trim();
    return req.socket.remoteAddress ?? "unknown";
}

function countConnectionsFromIp(conns, ip) {
    let count = 0;
    for (const conn of conns.values()) if (conn.ip === ip) count++;
    return count;
}

function newBucket(now) {
    return { tokens: RATE_CAPACITY, last: now };
}

// Leaky/token bucket: refill by elapsed time, spend one token per message.
function takeToken(bucket, now) {
    const elapsedSec = Math.max(0, (now - bucket.last) / 1000);
    bucket.tokens = Math.min(RATE_CAPACITY, bucket.tokens + elapsedSec * RATE_REFILL_PER_SEC);
    bucket.last = now;
    if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return true;
    }
    return false;
}

// Serve static files from publicDir with directory-traversal protection.
function serveStatic(req, res, publicDir) {
    if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
    }
    if (req.url === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        return;
    }

    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const resolved = path.resolve(publicDir, relative);

    // Reject anything that escapes the public root.
    if (resolved !== publicDir && !resolved.startsWith(publicDir + path.sep)) {
        res.writeHead(403).end();
        return;
    }

    fs.readFile(resolved, (err, data) => {
        if (err) {
            res.writeHead(404, { "content-type": "text/plain" }).end("not found");
            return;
        }
        const type = CONTENT_TYPES[path.extname(resolved)] ?? "application/octet-stream";
        res.writeHead(200, { "content-type": type }).end(data);
    });
}

// ----- Entry point (when run directly) ----------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const port = Number(process.env.PORT) || 3000;
    // Bind all interfaces by default: in production Docker maps host
    // 127.0.0.1:3006 -> container :3000, so exposure is controlled by the
    // compose port binding (and UFW), not by the app's bind address.
    const host = process.env.HOST || "0.0.0.0";
    const here = path.dirname(fileURLToPath(import.meta.url));
    const { httpServer } = createGameServer({ publicDir: path.resolve(here, "..", "public") });
    httpServer.listen(port, host, () => {
        console.log(`pinochle server listening on ${host}:${port}`);
    });
}
