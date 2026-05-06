/* Constraint-propagation inference engine for the Live Play tab.

   Maintains a "what we know" matrix per (seat, suit), plus per-seat HCP
   brackets, and tightens both as the auction is parsed and as cards are
   played out. Pure functions; no React, no I/O. Designed to be called from
   inside a useMemo so it re-runs on every play but stays cheap (<5ms in
   practice).

   Design notes:

   - Constraints are a *floor* on certainty. We never claim something we
     don't know — when we don't know whether E or W has the king, both are
     possible until evidence narrows it.
   - Show-out detection is the cleanest signal: when a player fails to
     follow suit, that suit's max for that player drops to 0.
   - Cross-suit propagation: each seat holds (13 - tricksPlayed) cards.
     If three suits' maxLengths sum to less than that, the fourth suit's
     minLength rises.
   - Cross-seat propagation: each suit has a known unseen count. If three
     seats' maxLengths in that suit sum to less than the unseen count, the
     fourth seat's minLength in that suit rises.
   - Auction seeding is best-effort and conservative — we don't try to be
     clever with conventions (those are engine-aware in v3.5 per CLAUDE.md). */

import { POSITIONS, POS_INDEX, SUIT_LIST, RANKS_DESC, HONORS_HCP, RANK_VAL } from '../sharedHelpers.js';

const SUITS = SUIT_LIST; // alias for readability inside this module

/* ------------------------------------------------------------------
   State construction
   ------------------------------------------------------------------ */

/* Build initial constraints given:
     myHand:     the user's 13 cards as [{suit, rank}, ...]
     dummyHand:  optional, same shape; null if not yet entered
     dummySeat:  'N'|'E'|'S'|'W' or null
     auction, dealer:  for HCP/length seeding
     leadContext: pre-computed deriveLeadContext output (declarerSuits etc.)

   Returns a Constraints object indexed by seat:
     {
       N: { S: { minLen, maxLen, knownRanks: Set, deniedRanks: Set }, H, D, C, hcpMin, hcpMax },
       E: ...,
       S: ...,
       W: ...,
       seen: Set<cardId>,         // every card whose location is fully known
       playedBy: { N: [], E: [], S: [], W: [] }, // cards each seat has played
     }
*/
export function buildConstraints({ myHand, dummyHand, dummySeat, auction, dealer, leadContext }) {
  const c = {
    N: emptySeat(), E: emptySeat(), S: emptySeat(), W: emptySeat(),
    seen: new Set(),
    playedBy: { N: [], E: [], S: [], W: [] },
  };

  // ---- South: fully known from myHand ----
  setSeatFromHand(c, 'S', myHand || []);
  // ---- Dummy: fully known if entered ----
  if (dummyHand && dummySeat) setSeatFromHand(c, dummySeat, dummyHand);

  // ---- Defenders / unknown seats: compute remaining unseen cards, distribute ----
  const seenCards = new Set();
  for (const card of myHand || []) seenCards.add(card.rank + card.suit);
  for (const card of dummyHand || []) seenCards.add(card.rank + card.suit);

  // For each suit, count unseen
  const unseenBySuit = {};
  for (const s of SUITS) unseenBySuit[s] = 13;
  for (const id of seenCards) unseenBySuit[id[1]]--;

  // Find which seats are "unknown" (not S, not the entered dummy)
  const unknownSeats = POSITIONS.filter((p) => p !== 'S' && p !== dummySeat);

  for (const seat of unknownSeats) {
    for (const suit of SUITS) {
      c[seat][suit].minLen = 0;
      c[seat][suit].maxLen = unseenBySuit[suit];
      c[seat][suit].deniedRanks = new Set();
      c[seat][suit].knownRanks = new Set();
    }
    // HCP bracket: split remaining 40 - shown HCP among unknown seats
    const knownHCP = countKnownHCP(c);
    const unknownHCP = 40 - knownHCP;
    c[seat].hcpMin = 0;
    c[seat].hcpMax = unknownHCP;
  }

  // ---- Auction-driven tightening ----
  applyAuctionConstraints(c, auction, dealer, leadContext);

  // ---- Initial fixpoint propagation ----
  propagate(c, { tricksPlayedBySeat: zerosBySeat(), unseenBySuit });

  return c;
}

function emptySeat() {
  const seat = { hcpMin: 0, hcpMax: 40 };
  for (const s of SUITS) {
    seat[s] = { minLen: 0, maxLen: 13, knownRanks: new Set(), deniedRanks: new Set() };
  }
  return seat;
}

function setSeatFromHand(c, seat, cards) {
  for (const s of SUITS) {
    c[seat][s].knownRanks = new Set();
    c[seat][s].deniedRanks = new Set();
    c[seat][s].minLen = 0;
    c[seat][s].maxLen = 0;
  }
  for (const card of cards) {
    c[seat][card.suit].knownRanks.add(card.rank);
    c[seat][card.suit].minLen += 1;
    c[seat][card.suit].maxLen += 1;
    c.seen?.add(card.rank + card.suit);
  }
  // Other ranks in those suits are denied to this seat (we know what they have)
  for (const s of SUITS) {
    for (const r of RANKS_DESC) {
      if (!c[seat][s].knownRanks.has(r)) c[seat][s].deniedRanks.add(r);
    }
  }
  // HCP exact
  let hcp = 0;
  for (const card of cards) hcp += HONORS_HCP[card.rank] || 0;
  c[seat].hcpMin = hcp;
  c[seat].hcpMax = hcp;
}

function countKnownHCP(c) {
  let total = 0;
  for (const seat of POSITIONS) {
    for (const s of SUITS) {
      for (const r of c[seat][s].knownRanks) {
        total += HONORS_HCP[r] || 0;
      }
    }
  }
  return total;
}

function zerosBySeat() {
  return { N: 0, E: 0, S: 0, W: 0 };
}

/* ------------------------------------------------------------------
   Auction seeding
   ------------------------------------------------------------------ */

function applyAuctionConstraints(c, auction, dealer, leadContext) {
  if (!auction || auction.length === 0) return;
  const dealerIdx = POS_INDEX[dealer];
  const bidsBySeat = { N: [], E: [], S: [], W: [] };
  for (let i = 0; i < auction.length; i++) {
    bidsBySeat[POSITIONS[(dealerIdx + i) % 4]].push(auction[i]);
  }

  for (const seat of POSITIONS) {
    if (seat === 'S') continue; // we already know our hand exactly
    const reals = bidsBySeat[seat].filter((b) => b.type === 'bid');
    if (reals.length === 0) continue;

    const first = reals[0];
    // 1NT opening: 15-17 HCP, 2-5 in every suit
    if (first.level === 1 && first.denom === 'NT') {
      tightenHCP(c, seat, 15, 17);
      for (const s of SUITS) {
        tightenLength(c, seat, s, 2, 5);
      }
    }
    // 1H or 1S opening: 5+ in that major, 12-21 HCP
    else if (first.level === 1 && (first.denom === 'H' || first.denom === 'S')) {
      tightenHCP(c, seat, 12, 21);
      tightenLength(c, seat, first.denom, 5, 13);
    }
    // 1C or 1D opening: 3+ in that minor, 12-21 HCP
    else if (first.level === 1 && (first.denom === 'C' || first.denom === 'D')) {
      tightenHCP(c, seat, 12, 21);
      tightenLength(c, seat, first.denom, 3, 13);
    }
    // Weak two: 6-card suit, 5-11 HCP
    else if (first.level === 2 && (first.denom === 'D' || first.denom === 'H' || first.denom === 'S')) {
      tightenHCP(c, seat, 5, 11);
      tightenLength(c, seat, first.denom, 6, 6);
    }
    // 2C strong: 22+ HCP
    else if (first.level === 2 && first.denom === 'C') {
      tightenHCP(c, seat, 22, 40);
    }
    // 2NT opening: 20-21 HCP balanced
    else if (first.level === 2 && first.denom === 'NT') {
      tightenHCP(c, seat, 20, 21);
      for (const s of SUITS) tightenLength(c, seat, s, 2, 5);
    }
  }

  // Takeout-shape doubles (already classified by deriveLeadContext)
  if (leadContext?.doubles) {
    // Find the takeout doubler seat — pick out doubles in the auction
    for (let i = 0; i < auction.length; i++) {
      if (auction[i].type !== 'dbl') continue;
      // re-do the classification to find the doubler seat
      const doublerIdx = (dealerIdx + i) % 4;
      const doublerSeat = POSITIONS[doublerIdx];
      // find doubled bid
      let dIdx = -1;
      for (let j = i - 1; j >= 0; j--) {
        if (auction[j].type === 'bid') { dIdx = j; break; }
        if (auction[j].type === 'dbl' || auction[j].type === 'rdbl') break;
      }
      if (dIdx < 0) continue;
      const doubledBid = auction[dIdx];
      if (doubledBid.denom === 'NT' || doubledBid.level > 2) continue;
      const priorReals = [];
      for (const x of bidsBySeat[doublerSeat]) {
        if (x === auction[i]) break;
        if (x.type === 'bid') priorReals.push(x);
      }
      const isTakeout = priorReals.length === 0
        || (priorReals.length === 1 && priorReals[0].level === 1);
      if (!isTakeout) continue;
      if (doublerSeat === 'S') continue;
      // Takeout double promises ~3+ in each unbid suit and shortness in doubled
      const unbid = SUITS.filter((s) => s !== doubledBid.denom);
      for (const u of unbid) tightenLength(c, doublerSeat, u, 3, 13);
      // doubler has at most 2 in the doubled suit (often 0-2)
      tightenLength(c, doublerSeat, doubledBid.denom, 0, 2);
      tightenHCP(c, doublerSeat, 12, 18);
    }
  }

  // Pass-throughout: 0-11 HCP cap (loose; some 4th-seat passes have more)
  for (const seat of POSITIONS) {
    if (seat === 'S') continue;
    if (bidsBySeat[seat].length > 0 && bidsBySeat[seat].every((b) => b.type === 'pass')) {
      tightenHCP(c, seat, 0, 11);
    }
  }
}

function tightenHCP(c, seat, lo, hi) {
  if (lo > c[seat].hcpMin) c[seat].hcpMin = lo;
  if (hi < c[seat].hcpMax) c[seat].hcpMax = hi;
}

function tightenLength(c, seat, suit, lo, hi) {
  if (lo > c[seat][suit].minLen) c[seat][suit].minLen = lo;
  if (hi < c[seat][suit].maxLen) c[seat][suit].maxLen = hi;
}

/* ------------------------------------------------------------------
   Card-play updates
   ------------------------------------------------------------------ */

/* Apply a single play to the constraints. Returns a new (mutated) constraints object.
   `play` = { seat, card: {suit, rank} }
   `currentTrick` = { leader, plays: [{seat, card}] } — used for show-out detection.
   `tricksPlayedBySeat` = how many tricks each seat has been in (int) BEFORE this play.
   `unseenBySuit` = unseen card counts BEFORE this play. */
export function applyPlay(c, play, currentTrick, tricksPlayedBySeat, unseenBySuit) {
  const { seat, card } = play;

  // Mark seen
  c.seen.add(card.rank + card.suit);
  c.playedBy[seat].push(card);

  // Remove from this seat's "known" / "possible" universe
  // If we knew the rank, drop from knownRanks
  c[seat][card.suit].knownRanks.delete(card.rank);
  c[seat][card.suit].minLen = Math.max(0, c[seat][card.suit].minLen - 1);
  c[seat][card.suit].maxLen = Math.max(0, c[seat][card.suit].maxLen - 1);
  // HCP shown: subtract from this seat's bracket
  const hcp = HONORS_HCP[card.rank] || 0;
  if (hcp > 0) {
    c[seat].hcpMin = Math.max(0, c[seat].hcpMin - hcp);
    c[seat].hcpMax = Math.max(0, c[seat].hcpMax - hcp);
  }

  // Mark this rank denied for all OTHER seats (it's been seen, no one else has it)
  for (const other of POSITIONS) {
    if (other === seat) continue;
    c[other][card.suit].deniedRanks.add(card.rank);
    // If other had this rank as known, that's a contradiction; just drop it
    c[other][card.suit].knownRanks.delete(card.rank);
  }

  // Show-out detection: if there's a led suit and this player played a different one
  if (currentTrick.plays.length > 0) {
    const ledSuit = currentTrick.plays[0].card.suit;
    if (card.suit !== ledSuit) {
      // This seat is out of led suit
      c[seat][ledSuit].maxLen = 0;
      c[seat][ledSuit].minLen = 0;
      // All remaining ranks in led suit denied for this seat
      for (const r of RANKS_DESC) {
        c[seat][ledSuit].deniedRanks.add(r);
      }
    }
  }

  // Update unseen-by-suit
  const newUnseen = { ...unseenBySuit };
  newUnseen[card.suit]--;

  // Update tricks-played
  const newTricks = { ...tricksPlayedBySeat };
  newTricks[seat]++;

  // Re-propagate
  propagate(c, { tricksPlayedBySeat: newTricks, unseenBySuit: newUnseen });

  return c;
}

/* ------------------------------------------------------------------
   Constraint propagation (fixpoint loop)
   ------------------------------------------------------------------ */

function propagate(c, { tricksPlayedBySeat, unseenBySuit }) {
  for (let iter = 0; iter < 20; iter++) {
    let changed = false;

    // ---- Per-seat length sum constraint ----
    for (const seat of POSITIONS) {
      const remaining = 13 - (tricksPlayedBySeat[seat] || 0);
      const sumMin = SUITS.reduce((s, x) => s + c[seat][x].minLen, 0);
      const sumMax = SUITS.reduce((s, x) => s + c[seat][x].maxLen, 0);

      // Force per-suit min up if other suits' max can't fill remaining
      for (const suit of SUITS) {
        const otherMaxSum = sumMax - c[seat][suit].maxLen;
        const newMin = Math.max(c[seat][suit].minLen, remaining - otherMaxSum);
        if (newMin > c[seat][suit].minLen) {
          c[seat][suit].minLen = newMin;
          changed = true;
        }
        // Force per-suit max down if other suits' min force this one to be at most ...
        const otherMinSum = sumMin - c[seat][suit].minLen;
        const newMax = Math.min(c[seat][suit].maxLen, remaining - otherMinSum);
        if (newMax < c[seat][suit].maxLen && newMax >= c[seat][suit].minLen) {
          c[seat][suit].maxLen = newMax;
          changed = true;
        }
      }
    }

    // ---- Per-suit unseen cross-seat constraint ----
    for (const suit of SUITS) {
      const unseen = unseenBySuit[suit];
      // Unknown seats only — fully-known seats contribute their actual length
      const seatMaxes = POSITIONS.map((p) => c[p][suit].maxLen);
      const seatMins = POSITIONS.map((p) => c[p][suit].minLen);
      const totalMax = seatMaxes.reduce((a, b) => a + b, 0);
      const totalMin = seatMins.reduce((a, b) => a + b, 0);

      // For each seat: minLen >= unseen - sum of others' max
      for (let i = 0; i < 4; i++) {
        const seat = POSITIONS[i];
        // If this seat is fully known (S, dummy), skip
        if (c[seat][suit].minLen === c[seat][suit].maxLen) continue;
        const otherMaxSum = totalMax - seatMaxes[i];
        const newMin = Math.max(c[seat][suit].minLen, unseen - otherMaxSum);
        if (newMin > c[seat][suit].minLen) {
          c[seat][suit].minLen = newMin;
          changed = true;
          seatMins[i] = newMin;
        }
        const otherMinSum = totalMin - seatMins[i];
        const newMax = Math.min(c[seat][suit].maxLen, unseen - otherMinSum);
        if (newMax < c[seat][suit].maxLen && newMax >= c[seat][suit].minLen) {
          c[seat][suit].maxLen = newMax;
          changed = true;
          seatMaxes[i] = newMax;
        }
      }
    }

    if (!changed) break;
  }
}

/* ------------------------------------------------------------------
   UI-facing summaries
   ------------------------------------------------------------------ */

/* Render a human-readable summary per seat — used by the inferences panel. */
export function summarize(c) {
  const out = {};
  for (const seat of POSITIONS) {
    const lenStr = SUITS.map((s) => {
      const cell = c[seat][s];
      const range = cell.minLen === cell.maxLen ? `${cell.minLen}` : `${cell.minLen}-${cell.maxLen}`;
      return `${s}${range}`;
    }).join(' · ');
    const hcpStr = c[seat].hcpMin === c[seat].hcpMax
      ? `${c[seat].hcpMin} HCP`
      : `${c[seat].hcpMin}-${c[seat].hcpMax} HCP`;
    out[seat] = `${lenStr} · ${hcpStr}`;
  }
  return out;
}

/* For each card not yet seen, which seats could possibly hold it.
   Returns a map: cardId → Set<seat>. */
export function possibleHolders(c) {
  const result = {};
  for (const suit of SUITS) {
    for (const rank of RANKS_DESC) {
      const id = rank + suit;
      if (c.seen.has(id)) continue;
      const possible = new Set();
      for (const seat of POSITIONS) {
        const cell = c[seat][suit];
        // Possible if seat is not denied this rank AND maxLen > 0
        if (cell.deniedRanks.has(rank)) continue;
        if (cell.maxLen === 0) continue;
        if (cell.knownRanks.has(rank)) { result[id] = new Set([seat]); break; }
        possible.add(seat);
      }
      if (!result[id]) result[id] = possible;
    }
  }
  return result;
}

/* Total unseen card count by suit (used by the unseen-grid renderer). */
export function unseenCountBySuit(c) {
  const out = { S: 13, H: 13, D: 13, C: 13 };
  for (const id of c.seen) out[id[1]]--;
  return out;
}

/* Determine winner of a completed trick given the trump suit (or null for NT).
   Trick = { leader, plays: [{seat, card}, ...4] }. */
export function trickWinner(trick, trumpDenom) {
  const ledSuit = trick.plays[0].card.suit;
  let bestIdx = 0;
  for (let i = 1; i < trick.plays.length; i++) {
    const p = trick.plays[i];
    const best = trick.plays[bestIdx];
    const bestIsTrump = trumpDenom && best.card.suit === trumpDenom;
    const pIsTrump = trumpDenom && p.card.suit === trumpDenom;
    if (pIsTrump && !bestIsTrump) bestIdx = i;
    else if (pIsTrump && bestIsTrump) {
      if (RANK_VAL[p.card.rank] > RANK_VAL[best.card.rank]) bestIdx = i;
    } else if (!pIsTrump && !bestIsTrump && p.card.suit === ledSuit && best.card.suit === ledSuit) {
      if (RANK_VAL[p.card.rank] > RANK_VAL[best.card.rank]) bestIdx = i;
    } else if (!pIsTrump && !bestIsTrump && p.card.suit === ledSuit && best.card.suit !== ledSuit) {
      bestIdx = i;
    }
    // else: discard, doesn't beat anything
  }
  return trick.plays[bestIdx].seat;
}
