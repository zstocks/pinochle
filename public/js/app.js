// App orchestration: holds transient UI state, wires the socket to the renderer,
// translates clicks into protocol messages, and persists the reconnect token so a
// dropped (e.g. mobile) connection can re-claim its seat automatically.

import { createConnection } from "./net.js";
import { render } from "./render.js";
import { minBid, bidStep } from "./cards.js";

const STORAGE_KEY = "pinochle.session";
const CREATOR_SEAT = 0;   // the creator takes Red Player 1; others pick the rest
const root = document.getElementById("app");

const ui = {
    screen: "landing",   // "landing" until we're in a room
    mode: "home",        // landing sub-screen: "home" | "join"
    name: "",
    code: "",
    roomInfo: null,      // seat occupancy from a peek_room, for the join screen
    chosenSeat: null,
    error: null,
    copied: false,
    pendingBid: 0,
    selectedCard: null,
    activeSuit: "all",
    calcOpen: false,
    calcTrump: "none"
};

let view = null;
let status = "connecting";
let pendingReconnect = false;   // true while a reconnect attempt is outstanding

// A shared link (…/?room=CODE) means "take me straight to this room's join
// screen". Capture it, then clean the URL so a refresh doesn't re-trigger it.
let pendingRoomCode = null;
const roomParam = new URLSearchParams(location.search).get("room");
if (roomParam) {
    pendingRoomCode = roomParam.trim().toUpperCase();
    history.replaceState(null, "", location.pathname);
}

const net = createConnection({ onMessage, onStatus });

function draw() {
    render(root, { view, ui, status });
}

// ----- Socket lifecycle -------------------------------------------------------

function onStatus(next) {
    status = next;
    if (next === "open") {
        if (pendingRoomCode) {
            // Explicit join-by-link takes priority over auto-reconnect.
            net.send({ type: "peek_room", code: pendingRoomCode });
            pendingRoomCode = null;
        } else {
            const saved = loadSession();
            if (saved && !view) {
                pendingReconnect = true;
                net.send({ type: "reconnect", code: saved.code, token: saved.token });
            }
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

        case "room_info":
            ui.roomInfo = { code: msg.code, phase: msg.phase, seats: msg.seats };
            ui.code = msg.code;
            ui.mode = "join";
            ui.screen = "landing";
            ui.chosenSeat = null;
            ui.error = null;
            break;

        case "state":
            view = msg.view;
            ui.screen = "room";
            ui.error = null;
            reconcileSelection();
            if (view.game?.phase !== "bidding") ui.calcOpen = false;
            break;

        case "error":
            if (pendingReconnect) {
                // Our saved token was rejected — start fresh at the landing screen.
                pendingReconnect = false;
                clearSession();
                view = null;
                ui.screen = "landing";
                ui.mode = "home";
                ui.error = "Couldn't rejoin your game — it may have ended.";
            } else {
                ui.error = msg.message;
                // A failed join is often a seat someone just took — refresh the
                // seat map so the player can pick another.
                if (ui.mode === "join" && ui.roomInfo) {
                    net.send({ type: "peek_room", code: ui.roomInfo.code });
                }
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
    handleAction(el.dataset.action, el.dataset);
});

function handleAction(action, data) {
    // Snapshot any typed-but-unsent inputs before a re-render wipes them.
    captureInputs();

    switch (action) {
        case "do-create":
            net.send({ type: "create_room", name: nameOrDefault(), seat: CREATOR_SEAT });
            return;

        case "go-join":
            if (!ui.code) { ui.error = "Enter a room code."; break; }
            ui.error = null;
            net.send({ type: "peek_room", code: ui.code });
            return;

        case "choose-seat":
            ui.chosenSeat = Number(data.seat);
            break;

        case "do-join":
            if (ui.chosenSeat == null) { ui.error = "Pick an open seat."; break; }
            net.send({
                type: "join_room",
                code: ui.roomInfo.code,
                name: nameOrDefault(),
                seat: ui.chosenSeat
            });
            return;

        case "back-home":
            ui.mode = "home";
            ui.roomInfo = null;
            ui.chosenSeat = null;
            ui.error = null;
            break;

        case "copy-link":
            copyShareLink();
            return;

        case "toggle-calc":
            ui.calcOpen = !ui.calcOpen;
            break;
        case "calc-trump":
            ui.calcTrump = data.trump;
            break;
        case "close-calc":
            ui.calcOpen = false;
            break;

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
            ui.mode = "home";
            ui.roomInfo = null;
            ui.chosenSeat = null;
            ui.error = null;
            break;
    }
    draw();
}

function sendAction(action) {
    net.send({ type: "action", action });
}

function captureInputs() {
    const name = document.getElementById("name-input");
    if (name) ui.name = name.value;
    const code = document.getElementById("code-input");
    if (code) ui.code = code.value.trim().toUpperCase();
}

function nameOrDefault() {
    return (ui.name || "").trim() || "Player";
}

function copyShareLink() {
    const el = document.getElementById("share-link");
    if (!el) return;
    navigator.clipboard?.writeText(el.value).catch(() => { /* clipboard blocked */ });
    ui.copied = true;
    draw();
    setTimeout(() => { ui.copied = false; draw(); }, 2000);
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
