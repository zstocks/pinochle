const suits = ["C", "D", "H", "S"];
const ranks = ["J", "Q", "K", "10", "A"];
const rankValues = [1, 2, 3, 4, 5];

export function parseCard(card) {
    const suit = card.slice(-1); //Last character
    const rank = card.slice(0, -1); //Evertyhing except the last character
    return { rank: rank, suit: suit };
}

export function cardString({ rank, suit }) {
    return rank + suit;
}

export function rankValue(rank) {
    const index = ranks.indexOf(rank);
    return index !== -1 ? rankValues[index] : 0;
}

export function isCounter(card) {
    const { rank } = parseCard(card);
    return rank === "K" || rank === "10" || rank === "A";
}

export function makeDeck() {
    const deck = [];
    for (const suit of suits) {
        for (const rank of ranks) {
            for (let i = 0; i < 4; i++) {
                deck.push(cardString({ rank, suit }));
            }
        }
    }
    return deck;
}

export function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}