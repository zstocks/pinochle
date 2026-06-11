// Thin browser WebSocket client. Auto-reconnects the socket itself with backoff
// (the game-level reconnect — re-claiming your seat with a token — is handled in
// app.js once the socket is open again).

const PROTOCOL_VERSION = 1;
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;

export function createConnection({ onMessage, onStatus }) {
    let ws = null;
    let running = true;
    let backoff = INITIAL_BACKOFF_MS;

    function endpoint() {
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        return `${scheme}://${location.host}`;
    }

    function connect() {
        onStatus("connecting");
        ws = new WebSocket(endpoint());

        ws.addEventListener("open", () => {
            backoff = INITIAL_BACKOFF_MS;
            onStatus("open");
        });
        ws.addEventListener("message", (event) => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch {
                return;   // ignore unparseable frames
            }
            onMessage(message);
        });
        ws.addEventListener("close", () => {
            onStatus("closed");
            if (running) {
                setTimeout(connect, backoff);
                backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
            }
        });
        ws.addEventListener("error", () => {
            try { ws.close(); } catch { /* already closing */ }
        });
    }

    function send(payload) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ protocol_version: PROTOCOL_VERSION, ...payload }));
        }
    }

    connect();
    return {
        send,
        close() {
            running = false;
            ws?.close();
        }
    };
}
