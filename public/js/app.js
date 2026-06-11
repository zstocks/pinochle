// App orchestration: holds transient UI state, wires the socket to the renderer,
// translates clicks into protocol messages, and persists the reconnect token so a
// dropped (e.g. mobile) connection can re-claim its seat automatically.

import { createConnection } from "./net.js";
import { render } from "./render.js";
import { minBid, bidStep } from "./cards.js";

const STORAGE_KEY = "pinochle.session";
const root = document.getElementById("app");

const ui = {
    screen: "landing",   // "landing" until we're in a room
    name: "",
    code: "",
    chosenSeat: 0,
    error: null,
    pendingBid: 0,
    selectedCard: null,
    activeSuit: "all"
};

let view = null;
let status = "connecting";
let pendingReconnect = false;   // true while a reconnect attempt is outstanding

const net = createConnection({ onMessage, onStatus });

function draw() {
    render(root, { view, ui, status });
}

// ----- Socket lifecycle -------------------------------------------------------

function onStatus(next) {
    status = next;
    if (next === "open") {
        const saved = loadSession();
        if (saved && !view) {
            pendingReconnect = true;
            net.send({ type: "reconnect", code: saved.code, token: saved.token });
        }
    }
    draw();
}

function onMessage(msg) {
    switch (msg.type) {
        case "joined":
            saveSession({ code: msg.code, token: msg.token, seat: msg.seat });
            ui.error = null;
            pendingReconnect = false;
            break;
        case "state":
            view = msg.view;
            ui.screen = "room";
            ui.error = null;
            reconcileSelection();
            break;
        case "error":
            if (pendingReconnect) {
                // Our saved token was rejected — start fresh at the landing screen.
                pendingReconnect = false;
                clearSession();
                view = null;
                ui.screen = "landing";
                ui.error = "Couldn't rejoin your game — it may have ended.";
            } else {
                ui.error = msg.message;
            }
            break;
    }
    draw();
}

// Drop a stale card selection if it's no longer our turn or no longer legal.
function reconcileSelection() {
    const g = view.game;
    const yourTurn = g && g.phase === "tricks" && g.currentPlayer === view.you;
    if (!yourTurn) {
        ui.selectedCard = null;
        return;
    }
    if (ui.selectedCard && g.legalPlays && !g.legalPlays.includes(ui.selectedCard)) {
        ui.selectedCard = null;
    }
}

// ----- User actions (delegated click handling) --------------------------------

root.addEventListener("click", (event) => {
    const el = event.target.closest("[data-action]");
    if (!el) return;
    const { action, seat, suit, card } = el.dataset;
    handleAction(action, { seat, suit, card });
});

function handleAction(action, data) {
    switch (action) {
        case "choose-seat":
            // Tapping a seat re-renders the landing screen, so snapshot any
            // typed-but-unsent name/code first to avoid wiping the inputs.
            ui.name = document.getElementById("name-input")?.value ?? ui.name;
            ui.code = document.getElementById("code-input")?.value ?? ui.code;
            ui.chosenSeat = Number(data.seat);
            break;

        case "do-create":
            ui.name = nameInput();
            net.send({ type: "create_room", name: ui.name, seat: ui.chosenSeat });
            return;

        case "do-join":
            ui.name = nameInput();
            ui.code = codeInput();
            if (!ui.code) { ui.error = "Enter a room code."; break; }
            net.send({ type: "join_room", code: ui.code, name: ui.name, seat: ui.chosenSeat });
            return;

        case "ready":
            sendAction({ type: "start_game" });
            return;

        case "bid-inc": {
            const floor = minBid(view.game.bidding.currentBid);
            const current = Math.max(floor, ui.pendingBid || 0);
            ui.pendingBid = current + bidStep(current);
            break;
        }
        case "bid-dec": {
            const floor = minBid(view.game.bidding.currentBid);
            const current = Math.max(floor, ui.pendingBid || 0);
            ui.pendingBid = Math.max(floor, current - bidStep(current - 1));
            break;
        }
        case "bid": {
            const floor = minBid(view.game.bidding.currentBid);
            const amount = Math.max(floor, ui.pendingBid || 0);
            sendAction({ type: "bid", amount });
            ui.pendingBid = 0;
            return;
        }
        case "pass":
            sendAction({ type: "pass" });
            return;

        case "declare-trump":
            sendAction({ type: "declare_trump", suit: data.suit });
            return;

        case "ack-meld":
            sendAction({ type: "acknowledge_meld" });
            return;

        case "set-suit":
            ui.activeSuit = data.suit;
            break;

        case "select-card":
            ui.selectedCard = ui.selectedCard === data.card ? null : data.card;
            break;

        case "play-card":
            if (ui.selectedCard) {
                sendAction({ type: "play_card", card: ui.selectedCard });
                ui.selectedCard = null;
            }
            return;

        case "new-game":
            clearSession();
            view = null;
            ui.screen = "landing";
            ui.error = null;
            break;
    }
    draw();
}

function sendAction(action) {
    net.send({ type: "action", action });
}

function nameInput() {
    return document.getElementById("name-input")?.value.trim() || "Player";
}

function codeInput() {
    return document.getElementById("code-input")?.value.trim().toUpperCase() || "";
}

// ----- Session persistence ----------------------------------------------------

function saveSession(session) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)); } catch { /* private mode */ }
}

function loadSession() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { return null; }
}

function clearSession() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

draw();
