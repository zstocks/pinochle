import { test } from "node:test";
import assert from "node:assert/strict";
import { createGameServer } from "../src/server.js";

// These are integration smoke tests over real sockets — the protocol/redaction
// logic itself is unit-tested in protocol.test.js. Here we just confirm the glue
// wires messages, replies, and broadcasts together correctly.

const V = 1;

async function startServer() {
    const srv = createGameServer({ roomConfig: { reconnectWindowMs: 1000, idleTtlMs: 100_000 } });
    await new Promise((resolve) => srv.httpServer.listen(0, "127.0.0.1", resolve));
    return { srv, port: srv.httpServer.address().port };
}

// Connect a client and expose .opened, .next() (next message), and .waitFor(type).
function connect(port) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const queue = [];
    const waiters = [];

    ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(ev.data);
        if (waiters.length) waiters.shift()(msg);
        else queue.push(msg);
    });

    ws.opened = new Promise((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", (e) => reject(e), { once: true });
    });
    ws.next = () =>
        new Promise((resolve) => {
            if (queue.length) resolve(queue.shift());
            else waiters.push(resolve);
        });
    ws.waitFor = async (type) => {
        for (;;) {
            const m = await ws.next();
            if (m.type === type) return m;
        }
    };
    return ws;
}

function send(ws, msg) {
    ws.send(JSON.stringify(msg));
}

// ----- HTTP -------------------------------------------------------------------

test("serves a health check endpoint", async () => {
    const { srv, port } = await startServer();
    try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await res.text(), "ok");
    } finally {
        await srv.close();
    }
});

// ----- WebSocket flow ---------------------------------------------------------

test("create_room returns a joined reply and an initial state snapshot", async () => {
    const { srv, port } = await startServer();
    const ws = connect(port);
    try {
        await ws.opened;
        send(ws, { protocol_version: V, type: "create_room", name: "Al" });

        const joined = await ws.waitFor("joined");
        assert.ok(joined.token);
        assert.strictEqual(joined.seat, 0);

        const state = await ws.waitFor("state");
        assert.strictEqual(state.view.phase, "lobby");
        assert.strictEqual(state.view.players[0].name, "Al");
        assert.strictEqual(state.view.you, 0);
    } finally {
        ws.close();
        await srv.close();
    }
});

test("a malformed message gets an error reply (no crash)", async () => {
    const { srv, port } = await startServer();
    const ws = connect(port);
    try {
        await ws.opened;
        send(ws, { protocol_version: V, type: "create_room" });   // missing name
        const m = await ws.waitFor("error");
        assert.match(m.message, /name/);
    } finally {
        ws.close();
        await srv.close();
    }
});

test("a second player joins and both clients are broadcast the filled seat", async () => {
    const { srv, port } = await startServer();
    const a = connect(port);
    const b = connect(port);
    try {
        await a.opened;
        send(a, { protocol_version: V, type: "create_room", name: "A" });
        const aJoined = await a.waitFor("joined");
        await a.waitFor("state");   // drain the initial lobby snapshot

        await b.opened;
        send(b, { protocol_version: V, type: "join_room", code: aJoined.code, name: "B", seat: 1 });
        const bJoined = await b.waitFor("joined");
        assert.strictEqual(bJoined.seat, 1);

        // A receives a fresh broadcast now that seat 1 is taken.
        const aState = await a.waitFor("state");
        assert.strictEqual(aState.view.players[1].name, "B");
    } finally {
        a.close();
        b.close();
        await srv.close();
    }
});

test("an action without joining a room is rejected", async () => {
    const { srv, port } = await startServer();
    const ws = connect(port);
    try {
        await ws.opened;
        send(ws, { protocol_version: V, type: "action", action: { type: "start_game" } });
        const m = await ws.waitFor("error");
        assert.match(m.message, /not in a room/);
    } finally {
        ws.close();
        await srv.close();
    }
});
