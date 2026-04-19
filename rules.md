# Pinochle — Family Rules Spec

This document is the canonical specification for the variant of double Pinochle
played in this app. Implementation behavior must match what's written here.
When rules and code disagree, the rules win and the code is wrong.

---

## 1. Deck

- Two standard decks, nines removed.
- **Total cards: 80.**
- Each suit contains: 4 × Ace, 4 × 10, 4 × King, 4 × Queen, 4 × Jack (20 cards/suit).
- Trick-taking rank within a suit, high to low: **A > 10 > K > Q > J**.
- Trump beats any non-trump card regardless of rank.

## 2. Players and partnerships

- Exactly **4 players**, in two fixed partnerships of 2.
- Partnerships do not change during a game.
- Seating alternates opponents: partners sit across from each other.
  Turn order around the table is P1 → P2 (opponent) → P3 (P1's partner) → P4 (opponent) → P1.
- Dealer rotation: clockwise after each hand. First dealer of a game is chosen randomly.

## 3. Hand flow

Each hand proceeds in this fixed order:

1. Deal
2. Bidding (trump is called at the end)
3. Meld declaration
4. Trick-taking
5. Count counters and update scores

Exception: if the dealer auto-takes at 50 with no marriage (see §4), the hand
ends after bidding. No meld is declared, no tricks are played, and the dealing
team is set 50 points.

## 4. Dealing

- 80 cards ÷ 4 players = 20 cards per player.
- Cards are dealt **4 at a time**.
- Dealer deals; play proceeds clockwise starting with the player to dealer's left.

## 5. Bidding

### Eligibility
- A player **must** hold at least one marriage (K + Q of the same suit) to participate in bidding.
- A player without a marriage must pass.

### Opening
- Bidding opens at **50**.
- The player to the dealer's left has the option to open or pass.
- If all three non-dealer players pass, the dealer automatically takes the bid at 50
  (subject to the no-marriage exception below).

### Increments
- Between 50 and 59 inclusive: bids increase by **1 or more**.
- At 60 and above: bids increase by **5 or more**.
- There is no upper limit on a bid.

### Exit
- Once a player passes, they are **out of the auction** for that hand. No re-entry.

### Winning the bid
- Bidding ends when three consecutive players have passed.
- The highest bidder wins and becomes the **declarer**.
- The declarer must name a trump suit in which they hold a marriage.
- If the declarer holds marriages in multiple suits, they pick.

### Dealer auto-take, no-marriage edge case
- If the dealer auto-takes at 50 and does not hold a marriage, the dealing team
  is immediately **set 50 points**.
- The hand ends. No meld, no tricks. The next dealer (clockwise) deals the next hand.

## 6. Meld

Meld is scored before trick-taking, based on cards held after the deal.

### Declaration mechanics
- Meld is declared **simultaneously** by all players laying their meld-scoring
  cards face-up on the table.
- A team shows meld **only if their combined meld ≥ 20**. Below 20, the team
  keeps their cards hidden and declares nothing. Opponents do not learn whether
  the team was at 0 or 19.
- After declaration, all cards return to their owner's hand before the first trick.

### Meld categories and point values

| Meld | Requirement | Points |
|---|---|---|
| Marriage (non-trump) | K + Q, same non-trump suit | 2 |
| Marriage in trump | K + Q of trump suit | 4 |
| Round robin | K + Q in every suit | 24 |
| Family | A + 10 + K + Q + J of trump suit | 16 |
| Double family | 2× each of A, 10, K, Q, J of trump | 150 |
| Round of Aces | A in every suit | 10 |
| Double round of Aces | 2× A in every suit | 100 |
| Round of Kings | K in every suit | 8 |
| Double round of Kings | 2× K in every suit | 80 |
| Round of Queens | Q in every suit | 6 |
| Double round of Queens | 2× Q in every suit | 60 |
| Round of Jacks | J in every suit | 4 |
| Double round of Jacks | 2× J in every suit | 40 |
| Pinochle | Q♠ + J♦ | 4 |
| Double Pinochle | 2× (Q♠ + J♦) | 30 |
| Triple Pinochle | 3× (Q♠ + J♦) | 90 |

### Double-counting rules

The core principle: **a card can be used in at most one meld per category,
but categories don't share cards within themselves**. Categories for this
purpose are:

- Marriages/family/round-robin (the "structures" category)
- Rounds of Aces, Kings, Queens, Jacks (each round is its own category? see below)
- Pinochle

To avoid ambiguity, the specific overlap rules:

- **Marriage in trump vs. non-trump marriage.** A K+Q of trump counts *only* as
  marriage in trump (4), not additionally as a non-trump marriage.
- **Family in trump includes the trump marriage.** If the hand has a family,
  the K+Q within it is already counted in the 16. Additional K+Q pairs of trump
  beyond the one used in the family count as additional trump marriages (4 each).
- **Round robin overrides individual marriages.** If a hand contains K+Q in every
  suit, score 24 — not 24 plus the individual marriages. (The round robin is
  the *way* of counting K+Q-in-every-suit; it doesn't stack with its components.)
- **Double family is 150 flat.** Do not add 16 twice for the two families within it.
- **Multiple trump marriages stack.** Two K+Q pairs of trump, no family = 4 + 4 = 8.
- **Cards cross categories freely.** Examples with spades as trump:
  - A Q♠ can count toward family (trump), round of queens, and pinochle
    simultaneously. It's one card serving three categories.
  - A J♦ can count toward pinochle without preventing a family from also being scored.
- **Partial family has no bonus.** A + K + Q + J of trump without the 10 scores
  as the individual parts (marriage in trump = 4, plus any rounds it contributes to).

### Non-trump family
- Family is **trump-only**. A + 10 + K + Q + J of a non-trump suit scores only its
  parts (marriage = 2, plus rounds it contributes to). No "family" bonus.

## 7. Trick-taking

### Lead
- The **declarer leads the first trick**.
- Winner of each trick leads the next.
- Play proceeds clockwise.

### Legal play, in priority order
When it's your turn:

1. **If void in the led suit:**
   a. If you have trump, you must play trump.
   b. If another trump has already been played to this trick, you must **beat it** if you can.
   c. If you cannot beat the highest trump already played, you play any trump.
   d. If you have no trump and are void in the led suit, play anything.
2. **If you can follow suit:**
   a. You must follow suit.
   b. If you can beat the highest card currently played to the trick (in the led suit or, if trumped, in trump), you must play a card that does.
   c. If you cannot beat it, play any card in the led suit.

Rule of thumb: **follow suit if able, and beat if able**. Trump is only forced when void in the led suit.

### Identical cards
- When two or more identical cards (e.g. both Ace of Spades) are played to the
  same trick, the **first one played wins** the tie.

### Counters
- Counters are scored by the team that **wins the trick containing them**.
- Values: A = 1, 10 = 1, K = 1. Q and J are non-counters (0).
- With 16 each of A/10/K in the deck, card counters total **48 per hand**.

### Last-trick bonus
- The team that wins the **final (20th) trick** scores **2 additional counters**.
- Total counters available per hand: **50**.

## 8. Scoring

### Hand-end scoring

Let `bid` be the winning bid, `meld_W` the declarer team's meld (0 if not declared),
`meld_L` the opposing team's meld (0 if not declared), `counters_W` and
`counters_L` the counters each team pulled (including the last-trick bonus).
`counters_W + counters_L = 50`.

**Declarer team:**

The declarer team must pull **at least 20 counters** regardless of meld, AND
they must pull enough counters to cover `bid - meld_W`. The effective threshold
is `max(20, bid - meld_W)`.

- If `meld_W < 20`: declarer team is set. `score_W -= bid`.
- Else if `counters_W < max(20, bid - meld_W)`: declarer team is set. `score_W -= bid`.
- Else: `score_W += meld_W + counters_W`.

The 20-counter floor matters most when the bid is low relative to meld — e.g.
bid = 50, meld = 60 means `bid - meld = -10`, but the team still must pull 20+
counters or they're set.

**Non-declarer team:**
- If `meld_L ≥ 20` AND `counters_L ≥ 20`: `score_L += meld_L + counters_L`.
- If `meld_L ≥ 20` AND `counters_L < 20`: no change. Meld not saved, counters not kept.
- If `meld_L < 20` AND `counters_L ≥ 20`: `score_L += counters_L`. (Counters only, no meld.)
- If `meld_L < 20` AND `counters_L < 20`: no change.

### Negative scores
- Scores can go below zero.

### Game end
- Game ends when **either team reaches 500 points** at the end of a hand.
- If both teams reach 500 in the same hand, the **declarer's team wins** the tie.
- Scores are only checked at the end of a hand, not mid-hand.

## 9. Open questions (things not yet specified)

*(To be resolved before or during implementation. Placeholder for spec growth.)*

- None currently. This section exists so that when edge cases arise during
  build, they get documented here and answered once, rather than re-litigated.
