// Pure card/bidding helpers for the frontend. No DOM, no dependencies, so this
// module is unit-testable in Node and keeps public/ a self-contained bundle.
// (It re-states the few tiny pieces of the engine the client needs; the server
// remains authoritative for every actual decision.)

export const RANKS_HIGH_TO_LOW = ["A", "10", "K", "Q", "J"];

// Suit tab order, chosen to alternate colors: black, red, black, red.
export const SUIT_ORDER = ["S", "D", "C", "H"];

export const SUIT_INFO = {
    S: { symbol: "♠", color: "black", label: "Spades" },
    D: { symbol: "♦", color: "red", label: "Diamonds" },
    C: { symbol: "♣", color: "black", label: "Clubs" },
    H: { symbol: "♥", color: "red", label: "Hearts" }
};

export function suitOf(card) {
    return card.slice(-1);
}

export function rankOf(card) {
    return card.slice(0, -1);
}

export function parseCard(card) {
    return { rank: rankOf(card), suit: suitOf(card) };
}

function rankIndex(rank) {
    const i = RANKS_HIGH_TO_LOW.indexOf(rank);
    return i === -1 ? RANKS_HIGH_TO_LOW.length : i;
}

// Sort cards high to low by rank (A > 10 > K > Q > J).
export function sortByRank(cards) {
    return [...cards].sort((a, b) => rankIndex(rankOf(a)) - rankIndex(rankOf(b)));
}

// Group a hand into { S, D, C, H } lists, each sorted high to low.
export function groupBySuit(hand) {
    const groups = { S: [], D: [], C: [], H: [] };
    for (const card of hand) groups[suitOf(card)].push(card);
    for (const suit of SUIT_ORDER) groups[suit] = sortByRank(groups[suit]);
    return groups;
}

export function countsBySuit(hand) {
    const counts = { S: 0, D: 0, C: 0, H: 0 };
    for (const card of hand) counts[suitOf(card)] += 1;
    return counts;
}

// Does the hand hold a marriage (K+Q of a suit)? Used to enable/disable the Bid
// button; the server still enforces eligibility.
export function hasMarriage(hand) {
    return SUIT_ORDER.some((s) => hand.includes("K" + s) && hand.includes("Q" + s));
}

// The suits in which the hand holds a marriage — the legal trump choices.
export function marriageSuits(hand) {
    return SUIT_ORDER.filter((s) => hand.includes("K" + s) && hand.includes("Q" + s));
}

// Minimum legal next bid (rules.md §5): opens at 50, +1 below 60, +5 at/above 60.
export function minBid(currentBid) {
    if (currentBid === 0) return 50;
    if (currentBid < 60) return currentBid + 1;
    return currentBid + 5;
}

// Step size for the bid stepper at a given value.
export function bidStep(value) {
    return value < 60 ? 1 : 5;
}
