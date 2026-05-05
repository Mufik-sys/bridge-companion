# Phase 2 — Live trick tracker

## Goal

A new "Live deal" tab where the user enters their hand and (later) dummy's hand, taps each card as it's played in real time, and gets running inferences plus heuristic next-card suggestions. Designed to be used while playing on Funbridge or any other online bridge app, on the same phone (Funbridge in foreground, this app in tab/PiP) or a second device.

The UX target: tapping a played card takes ≤1 second once you're used to it. Anything slower is worse than no tracker.

## Non-goals

- Not a card-play AI. No double-dummy solver, no Monte Carlo. Heuristics + constraint propagation only.
- No undo-of-undo or branching auctions. One linear deal per session, with full Reset.
- No multi-deal history view in this phase (Phase 3+).

## Data model

Lives alongside the existing engine code. Suggested split:

```
src/
├── engines/
│   ├── sayc.js          (extracted from BridgeTool.jsx — bidding engine)
│   ├── lead.js          (extracted — opening-lead heuristic)
│   └── inference.js     (NEW — constraint propagation)
├── store/
│   └── deal.js          (NEW — useDeal hook with reducer over deal state)
├── components/
│   └── ...              (extracted shared bits: HandInput, AuctionDisplay, etc.)
└── tabs/
    ├── Counter.jsx
    ├── Bidder.jsx
    ├── CardPlay.jsx     (existing static helper)
    └── LiveDeal.jsx     (NEW — this phase's home)
```

The **deal state** shape:

```js
{
  phase: 'setup' | 'auction' | 'lead' | 'play' | 'done',
  vul: 'None' | 'NS' | 'EW' | 'Both',
  dealer: 'N' | 'E' | 'S' | 'W',
  auction: Bid[],
  contract: { level, denom, declarer, doubled: 0|1|2 } | null,

  // Hands — myHand always set; dummy populated after opening lead
  myHand: Card[],          // 13 cards user entered up front
  dummyHand: Card[] | null,

  // Trick log
  tricks: Trick[],         // each is { leader, plays: [{player, card}], winner }
  currentTrick: { leader, plays: [{player, card}] }, // in-progress

  // Inference state — recomputed from auction + tricks; not stored separately
}

Card = { suit: 'S'|'H'|'D'|'C', rank: 'A'|'K'|'Q'|'J'|'T'|'9'..'2' }
```

## Inference engine (`src/engines/inference.js`)

Maintains a **constraint matrix** indexed by `(player, suit)`. For each cell:

```js
{
  minLength: number,        // floor we know
  maxLength: number,        // ceiling we know
  knownRanks: Set<rank>,    // ranks definitely held (e.g. dummy's exposed cards)
  deniedRanks: Set<rank>,   // ranks we've seen them not play when they could have
}
```

**Initial state** before bidding: each cell `{min: 0, max: 13, known: ∅, denied: ∅}` for opponents; my hand is fully constrained from `myHand`.

**Auction events tighten constraints:**

| Bid | Constraint applied |
|-----|---|
| 1NT opening | HCP bracket [15, 17], balanced shape (no suit < 2, no suit > 5) |
| 1♥ / 1♠ opening | 5+ in that major, 12+ HCP |
| 1♣ / 1♦ opening | 3+ in that minor, 12+ HCP |
| 2♣ opening | 22+ HCP (or specific rule-of-22 hands) |
| 2♥/2♠/2♦ opening | 5–11 HCP, 6 cards in suit |
| 1NT–2♣ Stayman reply 2♥ | 4+ hearts |
| 1NT–2♣ Stayman reply 2♦ | denial of 4-card major |
| Jacoby transfer 2♦ | 5+ hearts in transferer's hand |
| ... etc. |

**Card-play events tighten constraints further:**

- A player follows suit → no immediate constraint, but the played rank is removed from the universe of unseen cards
- A player **shows out** of a suit → set their `(suit, max) = 0`, recompute totals: their other suits' min/max get tighter
- Once enough constraints accumulate for a suit, "X has the missing king" can be deduced

**Total-length invariant:** for each player, `sum(min) ≤ remainingCardsInHand ≤ sum(max)`. After every event, run a fixpoint loop tightening each cell until stable.

## UI flow

### 1. Setup phase (≤30 seconds)

A 4×13 grid of suit×rank tiles. User taps the 13 cards they were dealt. Tapped cards go into `myHand` and are dimmed in the grid (so it's obvious if they undertap or duplicate). HCP and shape totals appear live as confirmation (auto-counted; no manual entry needed).

Vulnerability + dealer pickers, identical to the existing Bidder tab.

When `myHand.length === 13`, advance to auction phase.

### 2. Auction phase

Reuse the existing `BidKeypad` and `AuctionDisplay` from `BridgeTool.jsx`. Reuse `getRecommendation` for the bid suggestion. Difference from the existing Bidder tab: no separate hand entry — `myHand` is already known, so HCP and shape are pulled from there.

When the auction closes (3 passes after a contract bid), compute `contract` from the final bid and the side that bid that denomination first, advance to lead phase.

### 3. Lead phase (one-time interstitial)

If declarer is partner or self, skip directly to play phase. If declarer is an opponent and you're on lead: the existing `recommendOpeningLead` runs against `myHand` and the inferred opp constraints, suggesting a card. User taps the card they actually led; advance to play phase.

If you're dummy or partner is on lead, the user taps the card LHO led.

### 4. Play phase (the core of this tab)

UI is split into three zones:

**Top strip (sticky):** the current trick. Four slots, one per player (NESW), with the leader's slot highlighted. Each slot shows the card played there or empty. Below it: "Trick X · Leader: P".

**Middle:** my remaining hand (13 - tricks-played cards), suit-grouped. Tapping a card means "I played this card."

**Bottom:** input zone for opponents/partner. Two layouts to consider — pick one in implementation:

  - **Layout A (faster, dense):** A 4×13 grid of remaining unseen cards (cards not in my hand, not in dummy if known, not yet played). Tap means "the next-to-play player just played this card." Cards already played get dimmed.
  - **Layout B (clearer):** Per-trick, when it's not my turn, a "what did P play?" prompt shows a list of legal candidate cards (filtered by who's-to-play and what suit was led). Tap the card.

Recommend Layout A. It's denser and supports the speed target. Dummy's hand, once known, can be a separate strip showing dummy's remaining cards (tappable when dummy is to play).

After every play, the engine:
- Removes the card from its owner's `knownRanks`/universe
- Detects show-outs (player played a non-led suit when a led suit was active in the trick) → sets `max=0` for that player+suit
- Reruns the constraint propagator
- Determines trick winner, updates `tricks[]`, sets up next trick

**The Hint button:** bottom-right floating, surfaces one of:
- "Cash A♠ — partner's count signal showed 2 spades, declarer is out"
- "Duck the first heart — partner needs an entry"
- "Lead a low club through dummy's K♣"

Each hint cites the rule it applies (count, distribution, finesse position) so the user can decide whether the engine's reasoning matches the actual table.

## Heuristic recommendations (`src/engines/play.js`, NEW)

Rules to implement, in priority order:

1. **Forced plays** — if only one card legally follows suit, play it.
2. **Cash known winners** — when a side's tricks needed are immediately available from the constraint matrix.
3. **Established suit length** — count winners; if dummy's long suit is set up, cash it.
4. **Marked finesses** — if RHO is marked with the missing honor (HCP bracket from auction), finesse through.
5. **Duck for communication** — if entries are tight, suggest ducking the first round of declarer's long suit.
6. **Trump management** — for declarer: draw trumps unless you need to ruff in dummy first.

If multiple rules fire, return the highest-priority one with confidence "high" / "medium" / "low" based on how tight the constraints are.

When NO rule fires confidently, the engine returns "no clear recommendation — fall back to your own judgment" rather than guessing.

## Acceptance criteria

- [ ] User can complete setup → auction → contract → 13 tricks → done in under 5 minutes for a typical deal
- [ ] After every played card, the inferred distribution updates within 50ms
- [ ] At any point, the user can open a "Show inferences" panel that displays the constraint matrix in human-readable form ("West: 4-5 spades, 2-3 hearts, ...")
- [ ] The Hint button always returns either a recommendation or an explicit "no clear hint" — never nothing
- [ ] Reset button works at any phase, clears state, returns to setup
- [ ] Existing tabs (Counter, Bidder, CardPlay) still work and pass their existing engine smoke tests

## Out of scope for Phase 2

- Saving deals to localStorage / IndexedDB (Phase 2.5 if it proves useful)
- Multi-deal history
- Convention library overrides (Phase 3)
- Argine screenshot ingestion (Phase 3)

## Implementation order

1. Extract engines first — pull `recommendOpening`, `recommendResponseToOpen`, etc. into `src/engines/sayc.js`. Pull lead heuristic into `src/engines/lead.js`. Run the build, verify nothing breaks.
2. Extract shared components (`HandInput`, `AuctionDisplay`, `BidKeypad`) into `src/components/`.
3. Build the inference engine in isolation with hand-written test cases.
4. Build `LiveDeal.jsx` with the four phases, reusing extracted engines and components.
5. Wire up the heuristic-play module last; without it the tracker is already useful as a tracker.

## When in doubt

The user is in Sharjah, UAE, plays SAYC on Funbridge against Argine, and values **explanation alongside recommendation**. A correct recommendation with no reasoning is not a good answer — show why.
