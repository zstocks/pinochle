import { parseCard, rankValue } from "./cards.js";

// ----- Small helpers ----------------------------------------------------------
//
// These are tiny pure predicates that make the main logic read like English.
// They don't deserve to be exported — they're internal helpers.

function suitOf(card) {
    return parseCard(card).suit;
}

function rankOf(card) {
    return parseCard(card).rank;
}

// Does `challenger` beat `current` in the context of this trick?
// `ledSuit` is the suit of the first card played. `trump` is the trump suit.
// Returns true if challenger strictly beats current. Ties do NOT beat
// (first-played wins).
function beats(challenger, current, ledSuit, trump) {
    const cSuit = suitOf(challenger);
    const curSuit = suitOf(current);

    const challengerIsTrump = cSuit === trump;
    const currentIsTrump = curSuit === trump;

    if (challengerIsTrump && !currentIsTrump) return true;
    if (!challengerIsTrump && currentIsTrump) return false;

    if (challengerIsTrump && currentIsTrump) {
        return rankValue(rankOf(challenger)) > rankValue(rankOf(current));
    }

    // Neither is trump. Only led-suit cards can compete; off-suit never beats.
    if (cSuit !== ledSuit) return false;
    if (curSuit !== ledSuit) return true;  // shouldn't happen in valid play, but defensive

    return rankValue(rankOf(challenger)) > rankValue(rankOf(current));
}

// Find the currently-winning card in a trick-in-progress.
// Returns the card string, or null if the trick is empty.
function currentWinner(currentTrick, trump) {
    if (currentTrick.length === 0) return null;

    const ledSuit = suitOf(currentTrick[0].card);
    let winner = currentTrick[0].card;

    for (let i = 1; i < currentTrick.length; i++) {
        if (beats(currentTrick[i].card, winner, ledSuit, trump)) {
            winner = currentTrick[i].card;
        }
    }

    return winner;
}

// ----- Public API -------------------------------------------------------------

/**
 * Given a hand, the trick in progress, and the trump suit, return an array
 * of legal card strings the player may play.
 *
 * `currentTrick` is an array of { seat, card } in play order (length 0..3).
 * If empty, the player is leading and anything in hand is legal.
 *
 * Implements section 7 of rules.md:
 *   - If you can follow the led suit, you must. If you can beat the current
 *     winner while following suit, you must.
 *   - If void in led suit, you must play trump if you have it. If another
 *     trump is already played, you must over-trump it if you can.
 *   - If void in led suit and have no trump, play anything.
 */
export function legalPlays(hand, currentTrick, trump) {
    // TODO: Leading — if currentTrick is empty, return [...hand].
    if (currentTrick.length === 0) {
        return [...hand];
    }

    const ledSuit = suitOf(currentTrick[0].card);
    const winningCard = currentWinner(currentTrick, trump);
    const ledSuitCards = hand.filter((card) => suitOf(card) === ledSuit);
    const trumpCards = hand.filter((card) => suitOf(card) === trump);
    const otherCards = hand.filter(
        (card) => suitOf(card) !== ledSuit && suitOf(card) !== trump
    );

    if (ledSuitCards.length > 0) {
        const beaters = ledSuitCards.filter((card) => beats(card, winningCard, ledSuit, trump));
        if (beaters.length > 0) return beaters;
        return ledSuitCards;
    } else if (trumpCards.length > 0) {
        if (winningCard && suitOf(winningCard) === trump) {
            return trumpCards.filter((card) =>
                beats(card, winningCard, ledSuit, trump)
            );
        }
        else {
            return trumpCards;
        }
    } else {
        return otherCards;
    }
}

/**
 * Given a completed trick (length 4) and the trump suit, return the seat
 * index of the trick's winner. Ties go to the first-played card.
 */
export function trickWinner(trick, trump) {
    if (trick.length !== 4) {
        throw new Error(`trickWinner requires a 4-card trick, got ${trick.length}`);
    }

    let winning = trick[0];

    for (let i = 1; i < trick.length; i++) {
        if (beats(trick[i].card, winning.card, suitOf(trick[0].card), trump)) {
            winning = trick[i];
        }
    }

    return winning.seat;
}