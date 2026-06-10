import { makeDeck, shuffle } from "./cards.js";

// ----- Seat and team helpers --------------------------------------------------
//
// Seats are numbered 0..3 clockwise. Partnerships are fixed:
//   team_A = seats 0 + 2   (partners sit across from each other)
//   team_B = seats 1 + 3
//
// These helpers exist so seating math never appears as raw arithmetic in game
// logic. Reading `partnerOf(seat)` in a rule is clearer than `(seat + 2) % 4`,
// and if seating semantics ever change, the change lives in one place.

export function teamOf(seat) {
    return seat % 2 === 0 ? "team_A" : "team_B";
}

export function partnerOf(seat) {
    return (seat + 2) % 4;
}

export function nextSeat(seat) {
    return (seat + 1) % 4;
}

// ----- State construction -----------------------------------------------------

export function createInitialState(playerNames) {
    if (!Array.isArray(playerNames) || playerNames.length !== 4) {
        throw new Error(
            `createInitialState requires exactly 4 player names, got ${playerNames?.length}`
        );
    }

    const dealer = Math.floor(Math.random() * 4);

    return {
        phase: "dealing",

        seats: playerNames.map((name) => ({
            name,
            hand: []
        })),

        dealer,
        currentPlayer: null,  // set when bidding begins

        // Seat that won the auction (or the dealer on an auto-take). Set when the
        // auction resolves; distinct from bidding.highBidder because a dealer
        // auto-take has no high bidder.
        declarer: null,

        // True only during a dealer-auto-take-at-50-with-no-marriage hand
        // (rules.md §5). Decided at auction resolution, consumed at scoring.
        dealerNoMarriage: false,

        // Per-seat readiness for the engine's two "all four must act" barriers:
        // start_game (before each deal) and acknowledge_meld (after the meld
        // reveal, before tricks). Reset to all-false each time a barrier opens.
        ready: [false, false, false, false],

        scores: { team_A: 0, team_B: 0 },
        targetScore: 500,

        // Summary of the most recently scored hand, shown during the between-hands
        // review barrier. Null until the first hand has been scored.
        lastHandResult: null,

        // Winning team ("team_A"/"team_B") once a team has reached the target.
        winner: null,

        bidding: {
            currentBid: 0,
            highBidder: null,
            passed: [false, false, false, false],
            trump: null
        },

        meld: {
            declared: [null, null, null, null],
            teamTotals: { team_A: 0, team_B: 0 }
        },

        tricks: {
            currentTrick: [],
            ledSuit: null,
            completed: [],
            counters: { team_A: 0, team_B: 0 }
        }
    };
}

// ----- Dealing ----------------------------------------------------------------
//
// Takes a state in the "dealing" phase, returns a new state with 20 cards
// dealt to each seat and the phase moved to "bidding". Does not mutate input.

export function dealHand(state) {
    if (state.phase !== "dealing") {
        throw new Error(`dealHand requires phase "dealing", got "${state.phase}"`);
    }

    const deck = shuffle(makeDeck());

    // Deal 4 cards at a time, 5 rounds, for 20 cards per seat.
    // Start dealing to the seat left of the dealer.
    const hands = [[], [], [], []];
    let seat = nextSeat(state.dealer);
    while (deck.length > 0) {
        for (let i = 0; i < 4; i++) {
            hands[seat].push(deck.pop());
        }
        seat = nextSeat(seat);
    }

    return {
        ...state,
        phase: "bidding",
        currentPlayer: nextSeat(state.dealer),
        seats: state.seats.map((seatObj, i) => ({
            ...seatObj,
            hand: hands[i]
        }))
    };
}