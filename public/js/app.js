// App orchestration: holds transient UI state, wires the socket to the renderer,
// translates clicks into protocol messages, and persists the reconnect token so a
// dropped (e.g. mobile) connection can re-claim its seat automatically.

import { createConnection } from "./net.js";
import { render } from "./render.js";
import { minBid, bidStep, suitOf, outranks } from "./cards.js";
import { play } from "./sound.js";

const STORAGE_KEY = "pinochle.session";
const CREATOR_SEAT = 0;   // the creator takes Red Player 1; others pick the rest
const TRICK_REVIEW_SECONDS = 3;   // how long a completed trick stays on the table
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
    selectedIndex: null,   // index into your hand of the card you've tapped to play
    activeSuit: "all",
    calcOpen: false,
    calcTrump: "none",
    reviewTrick: null,   // a just-finished trick held on the table during the countdown
    reviewCount: 0
};

let view = null;
let status = "connecting";
let pendingReconnect = false;   // true while a reconnect attempt is outstanding
let reviewTimer = null;
// Sounds that should land when the trick-review countdown clears (so they match
// the moment the button/result actually appears), not when the state arrived.
let deferredSounds = [];

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

        case "state": {
            const oldView = view;
            view = msg.view;
            ui.screen = "room";
            ui.error = null;
            reconcileSelection();
            if (view.game?.phase !== "bidding") ui.calcOpen = false;
            playStateSounds(oldView, view, msg.events);
            maybeReviewTrick(msg.events);
            break;
        }

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

// When a trick just completed, hold its four cards on the table for a few
// seconds with a countdown before the (already-advanced) state is shown. Every
// client does this, so no one acts during the window.
function maybeReviewTrick(events) {
    const won = events && events.find((e) => e.type === "trick_won");
    if (!won) return;
    const completed = view.game?.tricks?.completed;
    if (!completed || completed.length === 0) return;

    clearInterval(reviewTimer);
    ui.reviewTrick = completed[completed.length - 1];   // { cards, winner }
    ui.reviewCount = TRICK_REVIEW_SECONDS;
    reviewTimer = setInterval(() => {
        ui.reviewCount -= 1;
        if (ui.reviewCount <= 0) {
            clearInterval(reviewTimer);
            reviewTimer = null;
            ui.reviewTrick = null;
            flushDeferredSounds();   // trump-attack / hand-end land as the next screen shows
        }
        draw();
    }, 1000);
}

// ----- Sound triggers ---------------------------------------------------------

// Turn the broadcast's events (and the before/after view) into sound cues. Most
// fire immediately; cues tied to UI that only appears after the trick-review
// countdown (the Trump Attack button, the hand-result screen) are deferred.
function playStateSounds(oldView, newView, events) {
    if (!events || !newView || !newView.game) return;
    const g = newView.game;
    const hasTrickWon = events.some((e) => e.type === "trick_won");

    for (const ev of events) {
        switch (ev.type) {
            case "hand_dealt": play("card-shuffle"); break;
            case "bid_made":   play("bid"); break;
            case "bid_passed": play("pass"); break;
            case "card_played": playCardSound(ev, g, hasTrickWon); break;
        }
    }

    // A hand finished. On a played hand the result screen appears only after the
    // last trick's review, so defer; a dealer-no-marriage hand has no trick to
    // review, so play it now.
    if (events.some((e) => e.type === "hand_scored")) {
        if (hasTrickWon) deferredSounds.push("hand-end");
        else play("hand-end");
    }

    // Trump Attack just became available to this client (we hold all trump and
    // no one else has any). The button only shows once the trick review clears,
    // so defer the cue to match.
    const becameAvailable = !oldView?.game?.canClaimRemaining && g.canClaimRemaining;
    if (becameAvailable) deferredSounds.push("trump-attack");
}

// A card hit the table. When trump was NOT led, an escalating cue plays as the
// trump war develops: the first trump-in (trump-1), then each successive
// *over-trump* — a trump that beats the highest trump so far (trump-2, then
// trump-3). A trump that can't beat the standing trump (a forced under-trump) is
// not an escalation, so it just flips like any other card.
function playCardSound(ev, g, hasTrickWon) {
    const trump = g.bidding.trump;
    // The trick this card belongs to: still in progress, or — if this card was
    // the 4th — already moved to `completed` in the same broadcast.
    const completed = g.tricks.completed;
    const trick = hasTrickWon && completed.length
        ? completed[completed.length - 1].cards
        : g.tricks.currentTrick;

    if (!trick || trick.length === 0) { play("card-flip"); return; }

    const ledSuit = suitOf(trick[0].card);
    if (!trump || ledSuit === trump || suitOf(ev.card) !== trump) {
        play("card-flip");
        return;
    }

    // Walk the trick in play order, tracking the highest trump and how many times
    // it has been beaten, to classify what the just-played (last) card did.
    let highestTrump = null;
    let overTrumps = 0;
    let cue = "card-flip";
    for (let i = 0; i < trick.length; i++) {
        const card = trick[i].card;
        const isLast = i === trick.length - 1;
        if (suitOf(card) !== trump) continue;
        if (highestTrump === null) {
            highestTrump = card;                      // first trump-in
            if (isLast) cue = "trump-1";
        } else if (outranks(card, highestTrump)) {
            overTrumps += 1;                          // a real over-trump
            highestTrump = card;
            if (isLast) cue = overTrumps === 1 ? "trump-2" : "trump-3";
        }
        // else: trump that can't beat the standing trump → no escalation (flip)
    }
    play(cue);
}

function flushDeferredSounds() {
    for (const name of deferredSounds) play(name);
    deferredSounds = [];
}

// Drop a stale card selection if it's no longer our turn, the index is gone, or
// the selected card is no longer a legal play.
function reconcileSelection() {
    const g = view.game;
    const yourTurn = g && g.phase === "tricks" && g.currentPlayer === view.you;
    if (!yourTurn) {
        ui.selectedIndex = null;
        return;
    }
    if (ui.selectedIndex == null) return;
    const hand = g.seats[view.you].hand || [];
    const card = hand[ui.selectedIndex];
    if (!card || (g.legalPlays && !g.legalPlays.includes(card))) {
        ui.selectedIndex = null;
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

        case "select-card": {
            // Identify by hand position, not card string — the hand holds
            // duplicates, so selecting by value would highlight every copy.
            const i = Number(data.index);
            if (ui.selectedIndex !== i) play("card-pick");   // selecting, not deselecting
            ui.selectedIndex = ui.selectedIndex === i ? null : i;
            break;
        }

        case "play-card":
            if (ui.selectedIndex != null) {
                const hand = view.game.seats[view.you].hand || [];
                const card = hand[ui.selectedIndex];
                if (card) sendAction({ type: "play_card", card });
                ui.selectedIndex = null;
            }
            return;

        case "claim-trump":
            sendAction({ type: "claim_remaining" });
            return;

        case "new-game":
            clearSession();
            clearInterval(reviewTimer);
            reviewTimer = null;
            ui.reviewTrick = null;
            deferredSounds = [];
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
