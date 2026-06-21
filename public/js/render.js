// Renders the whole UI from the current app state into a root element. Pure
// string templating + a single delegated click handler (wired in app.js via
// data-action attributes), so re-rendering on every server `state` message is
// cheap and stateless. Transient client state (selected card, active suit tab,
// landing inputs) lives in `ui` and is threaded through CTX.

import {
    SUIT_ORDER,
    SUIT_INFO,
    parseCard,
    suitOf,
    sortByRank,
    groupBySuit,
    countsBySuit,
    hasMarriage,
    marriageSuits,
    minBid,
    seatLabel,
    seatTeamColor
} from "./cards.js";

let CTX = { view: null, ui: {}, status: "connecting" };

export function render(root, ctx) {
    CTX = ctx;
    const { view, ui } = ctx;

    let html;
    if (ui.reviewTrick && view && view.game) {
        // A trick just finished: hold the four cards on the table for a beat
        // before the (already-advanced) state is shown.
        html = renderReview();
    } else if (!view || ui.screen === "landing") {
        html = renderLanding();
    } else if (view.phase === "lobby") {
        html = renderLobby();
    } else if (view.phase === "finished" || view.game?.phase === "complete") {
        html = renderGameOver();
    } else {
        html = renderGame();
    }

    root.innerHTML = `${connectionBanner()}${html}`;
}

// ----- Screens ----------------------------------------------------------------

function renderLanding() {
    return CTX.ui.mode === "join" ? renderJoin() : renderHome();
}

// Step 1: choose to create a game or enter a code to join one.
function renderHome() {
    const ui = CTX.ui;
    return `
    <div class="screen landing">
        <h1>Pinochle</h1>
        <div class="panel">
            <h2>New game</h2>
            <label class="field">Your name
                <input id="name-input" type="text" maxlength="20" autocomplete="off" value="${esc(ui.name || "")}">
            </label>
            <button class="btn primary big" data-action="do-create">Create game</button>
        </div>
        <div class="panel">
            <h2>Join a game</h2>
            <label class="field">Room code
                <input id="code-input" type="text" maxlength="4" autocomplete="off"
                       autocapitalize="characters" value="${esc(ui.code || "")}">
            </label>
            <button class="btn primary big" data-action="go-join">Continue</button>
        </div>
        ${ui.error ? `<p class="error">${esc(ui.error)}</p>` : ""}
    </div>`;
}

// Step 2 (join path): a peeked room — pick a name and an open seat.
function renderJoin() {
    const ui = CTX.ui;
    const info = ui.roomInfo;
    if (!info) {
        return `<div class="screen landing"><h1>Pinochle</h1><p class="hint">Loading room…</p></div>`;
    }
    if (info.phase !== "lobby") {
        return `
        <div class="screen landing">
            <h1>Pinochle</h1>
            <div class="panel">
                <p>Room <strong>${esc(info.code)}</strong> is no longer open to join.</p>
                <button class="btn big" data-action="back-home">Back</button>
            </div>
        </div>`;
    }

    const seatButtons = [0, 1, 2, 3]
        .map((i) => {
            const taken = info.seats[i];
            const color = seatTeamColor(i);
            if (taken) {
                return `<button class="seat-btn ${color} taken" disabled>
                    <span>${seatLabel(i)}</span><span class="seat-occupant">${esc(taken.name)}</span>
                </button>`;
            }
            const active = ui.chosenSeat === i ? "active" : "";
            return `<button class="seat-btn ${color} ${active}" data-action="choose-seat" data-seat="${i}">
                <span>${seatLabel(i)}</span><span class="seat-occupant">open</span>
            </button>`;
        })
        .join("");

    return `
    <div class="screen landing">
        <h1>Pinochle</h1>
        <div class="panel">
            <p class="room-code-line">Joining room <strong>${esc(info.code)}</strong></p>
            <label class="field">Your name
                <input id="name-input" type="text" maxlength="20" autocomplete="off" value="${esc(ui.name || "")}">
            </label>
            <p class="hint">Pick an open seat:</p>
            <div class="seat-buttons">${seatButtons}</div>
            <button class="btn primary big" data-action="do-join">Join game</button>
            <button class="btn" data-action="back-home">Back</button>
            ${ui.error ? `<p class="error">${esc(ui.error)}</p>` : ""}
        </div>
    </div>`;
}

function renderLobby() {
    const view = CTX.view;
    const shareUrl = `${location.origin}/?room=${encodeURIComponent(view.code)}`;
    const seats = [0, 1, 2, 3]
        .map((i) => {
            const p = view.players[i];
            const you = i === view.you ? " (you)" : "";
            const color = seatTeamColor(i);
            return `<li class="lobby-seat ${p ? "filled" : "open"} ${color}">
                <span class="seat-num">${seatLabel(i)}</span>
                <span class="seat-occupant">${p ? esc(p.name) + you : "(open)"}</span>
            </li>`;
        })
        .join("");

    return `
    <div class="screen lobby">
        <h1>Pinochle</h1>
        <p class="room-code">Room code <strong>${esc(view.code)}</strong></p>
        <div class="share">
            <input id="share-link" class="share-input" type="text" readonly value="${esc(shareUrl)}">
            <button class="btn" data-action="copy-link">${CTX.ui.copied ? "Copied!" : "Copy link"}</button>
        </div>
        <p class="hint">Share the code or link. The game begins when all four seats are filled.</p>
        <ul class="seat-list">${seats}</ul>
    </div>`;
}

function renderGameOver() {
    const view = CTX.view;
    const us = teamKey(view.you);
    const youWon = view.winner === us;
    const g = view.game;
    const scoreLine = g ? `Us ${g.scores[us]} &middot; Them ${g.scores[otherTeam(us)]}` : "";
    return `
    <div class="screen over">
        <h1>${youWon ? "You win! 🎉" : "You lost"}</h1>
        <p class="big-score">${scoreLine}</p>
        <button class="btn primary big" data-action="new-game">New game</button>
    </div>`;
}

// The in-play screen: status bar, table with the other three seats + a central
// area whose content depends on the game phase, then (usually) your hand.
function renderGame() {
    const g = CTX.view.game;
    let center;
    let showHand = true;

    switch (g.phase) {
        case "dealing": center = centerDealing(); showHand = false; break;
        case "bidding": center = centerBidding(); break;
        case "awaiting_trump": center = centerTrump(); break;
        case "meld": center = centerMeld(); break;
        case "tricks": center = centerTricks(); break;
        default: center = "";
    }

    const calc = g.phase === "bidding" ? renderMeldCalculator() : "";
    const claim = g.phase === "tricks" && g.canClaimRemaining
        ? `<div class="claim-bar"><button class="btn claim" data-action="claim-trump">⚡ Trump Attack — take the rest</button></div>`
        : "";
    const piles = g.phase === "tricks" ? renderTrickPiles() : "";
    const hand = showHand && g.seats[CTX.view.you].hand ? renderHand() : "";
    return `
        ${statusBar()}
        ${renderTable(center)}
        ${calc}
        ${claim}
        ${piles}
        ${hand}
        ${actionBar()}`;
}

// The completed trick held on the table during the between-tricks countdown.
function renderReview() {
    const t = CTX.ui.reviewTrick;
    const cards = t.cards
        .map(
            (p) => `
        <div class="trick-card ${p.seat === t.winner ? "winner" : ""}">
            ${cardFace(p.card, {})}
            <span class="trick-who">${playerName(p.seat)}${p.seat === t.winner ? " ✓" : ""}</span>
        </div>`
        )
        .join("");
    const center = `
        <div class="trick-area">${cards}</div>
        <div class="countdown">Next trick in ${CTX.ui.reviewCount}…</div>`;
    return `${statusBar()}${renderTable(center)}`;
}

// Two piles above the hand showing how many tricks each team has taken.
function renderTrickPiles() {
    const completed = CTX.view.game.tricks.completed;
    let red = 0;
    let black = 0;
    for (const t of completed) {
        if (teamKey(t.winner) === "team_A") red += 1;
        else black += 1;
    }
    return `
    <div class="trick-piles">
        <div class="pile red"><div class="pile-label">Red · Tricks Won</div><div class="pile-count">${red}</div></div>
        <div class="pile black"><div class="pile-label">Black · Tricks Won</div><div class="pile-count">${black}</div></div>
    </div>`;
}

// ----- Meld calculator (bidding phase) ----------------------------------------

// A collapsible helper above the hand: shows the meld this hand would score
// under no-trump or any one suit, with the cards for each combo. Data comes
// precomputed from the server (view.game.meldCalc), so it matches real scoring.
function renderMeldCalculator() {
    const ui = CTX.ui;
    const calc = CTX.view.game.meldCalc;
    if (!calc) return "";
    if (!ui.calcOpen) {
        return `<div class="calc-bar"><button class="btn" data-action="toggle-calc">🧮 Meld Calculator</button></div>`;
    }

    const selected = ui.calcTrump || "none";
    const options = [["none", "No Trump"], ...SUIT_ORDER.map((s) => [s, SUIT_INFO[s].symbol])];
    const trumps = options
        .map(([key, label]) => {
            const color = key === "none" ? "" : SUIT_INFO[key].color;
            const active = selected === key ? "active" : "";
            return `<button class="calc-trump-btn ${color} ${active}" data-action="calc-trump" data-trump="${key}">${label}</button>`;
        })
        .join("");

    const data = calc[selected];
    const combos = data.breakdown.length
        ? data.breakdown
              .map(
                  (b) => `
            <div class="meld-combo">
                <div class="combo-cards">${b.cards.map(miniCard).join("")}</div>
                <div class="combo-meta"><span>${esc(b.name)}</span><span class="combo-pts">${b.points}</span></div>
            </div>`
              )
              .join("")
        : `<p class="hint">No meld${selected === "none" ? " without a trump suit" : ""}.</p>`;

    return `
    <div class="calc-panel">
        <div class="calc-header">
            <strong>Meld Calculator</strong>
            <button class="btn" data-action="close-calc">Close</button>
        </div>
        <div class="calc-trumps">${trumps}</div>
        <div class="calc-combos">${combos}</div>
        <div class="calc-total">Total meld: <strong>${data.total}</strong></div>
    </div>`;
}

function miniCard(card) {
    const { rank, suit } = parseCard(card);
    const info = SUIT_INFO[suit];
    return `<span class="mini-card ${info.color}">${rank}${info.symbol}</span>`;
}

// ----- Table & status ---------------------------------------------------------

function renderTable(centerHTML) {
    const view = CTX.view;
    return `
    <div class="table">
        ${seatBadge((view.you + 2) % 4, "pos-top")}
        ${seatBadge((view.you + 1) % 4, "pos-left")}
        ${seatBadge((view.you + 3) % 4, "pos-right")}
        <div class="table-center">${centerHTML}</div>
    </div>`;
}

function seatBadge(seat, posClass) {
    const view = CTX.view;
    const g = view.game;
    const p = view.players[seat];
    const name = p ? esc(p.name) : "—";
    const disc = p && !p.connected ? ' <span class="disc">offline</span>' : "";
    const dealer = g.dealer === seat ? " Ⓓ" : "";
    const turn = g.currentPlayer === seat ? " turn" : "";
    const passed = g.phase === "bidding" && g.bidding.passed[seat] ? " (passed)" : "";
    return `
    <div class="seat ${posClass}${turn}">
        <div class="seat-name">${name}${dealer}${disc}</div>
        <div class="seat-meta">🂠 ${g.seats[seat].handCount}${passed}</div>
    </div>`;
}

function statusBar() {
    const g = CTX.view.game;
    const us = teamKey(CTX.view.you);
    const trump = g.bidding.trump ? suitGlyph(g.bidding.trump) : "—";
    const turn = g.currentPlayer != null ? playerName(g.currentPlayer) : "—";
    return `
    <div class="status-bar">
        <span>Trump ${trump}</span>
        <span>Bid ${g.bidding.currentBid || "—"}</span>
        <span>Us ${g.scores[us]} &middot; Them ${g.scores[otherTeam(us)]}</span>
        <span class="turn-indicator">▶ ${turn}</span>
    </div>`;
}

// ----- Phase centers ----------------------------------------------------------

function centerDealing() {
    const g = CTX.view.game;
    const youReady = g.ready[CTX.view.you];
    const readyCount = g.ready.filter(Boolean).length;
    const summary = g.lastHandResult ? handResultSummary() : `<p class="hint">First hand — get ready!</p>`;
    return `
    <div class="panel">
        ${summary}
        <p class="ready-count">${readyCount}/4 ready</p>
        <button class="btn primary big" data-action="ready" ${youReady ? "disabled" : ""}>
            ${youReady ? "Waiting…" : "Ready"}
        </button>
    </div>`;
}

function handResultSummary() {
    const view = CTX.view;
    const r = view.game.lastHandResult;
    const us = teamKey(view.you);
    const them = otherTeam(us);
    const fmt = (n) => (n > 0 ? `+${n}` : `${n}`);

    const row = (team) => {
        const isDecl = team === r.declarerTeam;
        const meld = r.meld[team];                         // null when under 20
        const counters = r.counters[team];
        const cls = team === "team_A" ? "red" : "black";
        const label = (team === "team_A" ? "Red" : "Black") + (team === us ? " (you)" : "");
        return `
        <tr class="${cls}">
            <td class="team-cell">${label}</td>
            <td>${meld != null ? meld : "—"}</td>
            <td>${r.dealerNoMarriage ? "—" : counters}</td>
            <td class="delta">${fmt(r.deltas[team])}</td>
        </tr>
        <tr class="note-row"><td colspan="4">${teamNote(r, team, isDecl, meld, counters)}</td></tr>`;
    };

    return `
    <div class="result">
        <h2>Hand result</h2>
        ${resultHeadline(r)}
        <table class="result-table">
            <thead><tr><th>Team</th><th>Meld</th><th>Ctrs</th><th>Score</th></tr></thead>
            <tbody>${row("team_A")}${row("team_B")}</tbody>
        </table>
        <p class="totals">Totals — Us ${r.scores[us]} &middot; Them ${r.scores[them]}</p>
    </div>`;
}

function resultHeadline(r) {
    if (r.trumpAttack) {
        const s = SUIT_INFO[r.trumpAttack.trump];
        return `<p class="result-headline">${playerName(r.trumpAttack.seat)} won all tricks with an excessive amount of <span class="${s.color}">${s.symbol}</span>!</p>`;
    }
    if (r.dealerNoMarriage) {
        return `<p class="result-headline">Dealer took at 50 with no marriage — no tricks played.</p>`;
    }
    const dealer = r.declarerTeam === "team_A" ? "Red" : "Black";
    return `<p class="result-headline">${dealer} bid ${r.bid}</p>`;
}

// Plain-language note for how a team's score came about.
function teamNote(r, team, isDecl, meld, counters) {
    if (isDecl) {
        if (r.dealerNoMarriage) return "Set — dealer held no marriage";
        if (r.declarerSet) return meld == null ? "Set — under 20 meld" : "Set — short on counters";
        return "Made the bid";
    }
    if (r.dealerNoMarriage) return meld != null ? "Saved meld" : "No meld saved";
    const savedCounters = counters >= 20;
    const savedMeld = meld != null && savedCounters;
    if (savedMeld) return "Saved meld + counters";
    if (savedCounters) return "Counters only — meld not saved";
    return "Saved nothing";
}

function centerBidding() {
    const view = CTX.view;
    const g = view.game;
    const you = view.you;
    const yourTurn = g.currentPlayer === you;
    const hand = g.seats[you].hand || [];

    let controls;
    if (yourTurn && !g.bidding.passed[you]) {
        const canBid = hasMarriage(hand);
        const pending = Math.max(minBid(g.bidding.currentBid), CTX.ui.pendingBid || 0);
        controls = `
        <div class="bid-controls">
            <div class="bid-stepper">
                <button class="btn" data-action="bid-dec">−</button>
                <span class="bid-amount">${pending}</span>
                <button class="btn" data-action="bid-inc">+</button>
            </div>
            <div class="bid-buttons">
                <button class="btn primary" data-action="bid" ${canBid ? "" : "disabled"}>
                    ${canBid ? `Bid ${pending}` : "No marriage"}
                </button>
                <button class="btn" data-action="pass">Pass</button>
            </div>
        </div>`;
    } else {
        controls = `<p class="hint">${yourTurn ? "You have passed." : `Waiting for ${playerName(g.currentPlayer)}…`}</p>`;
    }

    const high = g.bidding.highBidder != null ? ` by ${playerName(g.bidding.highBidder)}` : "";
    return `
    <div class="panel">
        <h2>Bidding</h2>
        <p>Current bid: <strong>${g.bidding.currentBid || "—"}</strong>${high}</p>
        ${controls}
    </div>`;
}

function centerTrump() {
    const view = CTX.view;
    const g = view.game;
    if (g.declarer === view.you) {
        const picks = marriageSuits(g.seats[view.you].hand)
            .map(
                (s) =>
                    `<button class="btn suit-pick ${SUIT_INFO[s].color}" data-action="declare-trump" data-suit="${s}">${SUIT_INFO[s].symbol} ${SUIT_INFO[s].label}</button>`
            )
            .join("");
        return `
        <div class="panel">
            <h2>You won the bid at ${g.bidding.currentBid}</h2>
            <p>Choose your trump suit:</p>
            <div class="suit-picker">${picks}</div>
        </div>`;
    }
    return `
    <div class="panel">
        <h2>${playerName(g.declarer)} won the bid</h2>
        <p class="hint">Waiting for them to name trump…</p>
    </div>`;
}

function centerMeld() {
    const view = CTX.view;
    const g = view.game;
    const youReady = g.ready[view.you];
    const us = teamKey(view.you);

    return `
    <div class="panel meld-panel">
        <h2>Meld</h2>
        <div class="meld-review">
            ${meldTeamBlock(us)}
            ${meldTeamBlock(otherTeam(us))}
        </div>
        <button class="btn primary big" data-action="ack-meld" ${youReady ? "disabled" : ""}>
            ${youReady ? "Waiting…" : "Continue"}
        </button>
    </div>`;
}

// One team's meld as laid on the table: each partner's full breakdown (with
// card symbols) plus the team total. A team under 20 lays down nothing, so we
// only ever see what the redacted view exposes — our own hand, and any team
// that reached the 20-point show threshold.
function meldTeamBlock(team) {
    const g = CTX.view.game;
    const total = g.meld.teamTotals[team];           // number, or null when hidden
    const seats = team === "team_A" ? [0, 2] : [1, 3];
    const label = team === teamKey(CTX.view.you) ? "Your team" : "Opponents";

    const visible = seats.filter((s) => g.meld.declared[s]);
    let body;
    if (visible.length) {
        body = visible.map((s) => meldPlayerBlock(s, g.meld.declared[s])).join("");
        if (total == null) body += `<p class="hint">Team total under 20 — not laid down.</p>`;
    } else {
        body = `<p class="hint">Under 20 — no meld shown.</p>`;
    }

    return `
    <div class="meld-team-block">
        <div class="meld-team-head"><strong>${label}</strong><span>${total != null ? total : "—"}</span></div>
        ${body}
    </div>`;
}

function meldPlayerBlock(seat, meld) {
    const who = seat === CTX.view.you ? `${playerName(seat)} (you)` : playerName(seat);
    const combos = meld.breakdown.length
        ? meld.breakdown
              .map(
                  (b) => `
            <div class="meld-combo">
                <div class="combo-cards">${b.cards.map(miniCard).join("")}</div>
                <div class="combo-meta"><span>${esc(b.name)}</span><span class="combo-pts">${b.points}</span></div>
            </div>`
              )
              .join("")
        : `<p class="hint">No meld.</p>`;
    return `
    <div class="meld-player">
        <div class="meld-player-head"><span>${who}</span><span class="meld-player-total">${meld.total}</span></div>
        ${combos}
    </div>`;
}

function centerTricks() {
    const g = CTX.view.game;
    if (g.tricks.currentTrick.length === 0) {
        const leader = g.currentPlayer;
        const text = leader === CTX.view.you ? "Your lead" : `Waiting for ${playerName(leader)} to lead…`;
        return `<div class="trick-area"><span class="hint">${text}</span></div>`;
    }
    const played = g.tricks.currentTrick
        .map(
            (p) =>
                `<div class="trick-card">${cardFace(p.card, {})}<span class="trick-who">${playerName(p.seat)}</span></div>`
        )
        .join("");
    return `<div class="trick-area">${played}</div>`;
}

// ----- Hand & action bar ------------------------------------------------------

function renderHand() {
    const view = CTX.view;
    const ui = CTX.ui;
    const g = view.game;
    const hand = g.seats[view.you].hand || [];
    const trump = g.bidding.trump;
    const yourTurn = g.phase === "tricks" && g.currentPlayer === view.you;
    const legal = g.legalPlays;   // array on your turn, else null
    const counts = countsBySuit(hand);
    const active = ui.activeSuit || "all";

    const isLegal = (card) => !legal || legal.includes(card);
    const drawCard = (card) =>
        cardFace(card, {
            selectable: yourTurn && isLegal(card),
            selected: ui.selectedCard === card,
            dimmed: yourTurn && legal && !isLegal(card)
        });

    const tabs = ["all", ...SUIT_ORDER]
        .map((t) => {
            const isAll = t === "all";
            const count = isAll ? hand.length : counts[t];
            const label = isAll ? "All" : SUIT_INFO[t].symbol;
            const cls = [
                "suit-tab",
                !isAll && SUIT_INFO[t].color,
                active === t && "active",
                !isAll && t === trump && "trump"
            ]
                .filter(Boolean)
                .join(" ");
            return `<button class="${cls}" data-action="set-suit" data-suit="${t}">${label}<span class="tab-count">${count}</span></button>`;
        })
        .join("");

    let body;
    if (active === "all") {
        const groups = groupBySuit(hand);
        body = SUIT_ORDER.filter((s) => groups[s].length)
            .map(
                (s) =>
                    `<div class="suit-row">
                        <span class="suit-row-label ${SUIT_INFO[s].color}">${SUIT_INFO[s].symbol}</span>
                        <div class="card-row">${groups[s].map(drawCard).join("")}</div>
                    </div>`
            )
            .join("");
    } else {
        const cards = sortByRank(hand.filter((c) => suitOf(c) === active));
        body = `<div class="card-row single">${cards.map(drawCard).join("") || '<span class="hint">No cards in this suit</span>'}</div>`;
    }

    return `
    <div class="hand">
        <div class="suit-tabs">${tabs}</div>
        <div class="hand-cards">${body}</div>
    </div>`;
}

function actionBar() {
    const g = CTX.view.game;
    if (g.phase !== "tricks" || g.currentPlayer !== CTX.view.you) return "";
    if (CTX.ui.selectedCard) {
        const { rank, suit } = parseCard(CTX.ui.selectedCard);
        return `<div class="action-bar">
            <button class="btn primary big" data-action="play-card">Play ${rank}${SUIT_INFO[suit].symbol}</button>
        </div>`;
    }
    return `<div class="action-bar hint">Select a card to play</div>`;
}

// ----- Card rendering ---------------------------------------------------------

function cardFace(card, { selectable, selected, dimmed }) {
    const { rank, suit } = parseCard(card);
    const info = SUIT_INFO[suit];
    const cls = [
        "card",
        info.color,
        selected && "selected",
        dimmed && "dimmed",
        selectable && "selectable"
    ]
        .filter(Boolean)
        .join(" ");
    const data = selectable ? `data-action="select-card" data-card="${card}"` : "";
    return `<div class="${cls}" ${data}>
        <span class="card-rank">${rank}</span>
        <span class="card-suit">${info.symbol}</span>
    </div>`;
}

// ----- Connection banner ------------------------------------------------------

function connectionBanner() {
    if (CTX.status === "open" || CTX.status === undefined) return "";
    const text = CTX.status === "closed" ? "Reconnecting…" : "Connecting…";
    return `<div class="conn-banner">${text}</div>`;
}

// ----- Small helpers ----------------------------------------------------------

function playerName(seat) {
    const p = CTX.view.players[seat];
    return p ? esc(p.name) : `Seat ${seat + 1}`;
}

function teamKey(seat) {
    return seat % 2 === 0 ? "team_A" : "team_B";
}

function otherTeam(team) {
    return team === "team_A" ? "team_B" : "team_A";
}

function teamLabel(team) {
    return team === teamKey(CTX.view.you) ? "Your team" : "Opponents";
}

function suitGlyph(suit) {
    return `<span class="${SUIT_INFO[suit].color}">${SUIT_INFO[suit].symbol}</span>`;
}

function esc(text) {
    return String(text).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
}
