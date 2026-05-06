/* Heuristic next-card recommender for the Live Play tab.

   v2.3 ships rules 1-4 only:
     1. Forced play (one legal card)
     2. Cash known winner
     3. Third hand high
     4. Second hand low

   Rules 5-7 (marked finesse, duck for communication, trump management)
   are deferred to a follow-up commit, deliberately, so the user can
   sanity-check the simpler heuristics before they pile up.

   Each suggestion returns:
     { card, rule, confidence: 'high'|'medium'|'low', reasoning: string }
   or null if no rule fires confidently. */

import { POSITIONS, POS_INDEX, RANK_VAL, RANKS_DESC, SYM, HONORS_HCP, SUIT_LIST } from '../sharedHelpers.js';
import { recommendOpeningLead } from './lead.js';

// (uses SUIT_LIST directly throughout — no local alias to avoid name collisions when test harness concatenates modules)

/* Compute the legal cards for a given seat from constraints + currentTrick.
   For South or dummy (fully known), it's their actual hand minus what they've played.
   For unknowns, return all "possible" cards from the constraint matrix. */
function legalCards(constraints, seat, ledSuit, ownHand) {
  // ownHand is the actual remaining cards if known, else null
  if (ownHand) {
    if (!ledSuit) return ownHand;
    // Suit-following rule: must follow if able
    const followers = ownHand.filter((c) => c.suit === ledSuit);
    return followers.length > 0 ? followers : ownHand;
  }
  // Fall back to constraint-derived possibles
  const possible = [];
  for (const suit of SUIT_LIST) {
    const cell = constraints[seat][suit];
    if (cell.maxLen === 0) continue;
    for (const r of RANKS_DESC) {
      if (cell.deniedRanks.has(r)) continue;
      possible.push({ suit, rank: r });
    }
  }
  if (!ledSuit) return possible;
  const followers = possible.filter((c) => c.suit === ledSuit);
  return followers.length > 0 ? followers : possible;
}

/* Sort cards low to high (rank ascending). */
function sortLowToHigh(cards) {
  return [...cards].sort((a, b) => RANK_VAL[a.rank] - RANK_VAL[b.rank]);
}

/* Pick the highest card from a set. */
function highest(cards) {
  return [...cards].sort((a, b) => RANK_VAL[b.rank] - RANK_VAL[a.rank])[0];
}

/* Pick the lowest card from a set. */
function lowest(cards) {
  return [...cards].sort((a, b) => RANK_VAL[a.rank] - RANK_VAL[b.rank])[0];
}

/* ---- Rule 1: Forced play ---- */
function ruleForced(legal) {
  if (legal.length === 1) {
    return {
      card: legal[0],
      rule: 'forced',
      confidence: 'high',
      reasoning: `Forced — only ${legal[0].rank}${SYM[legal[0].suit]} is legal.`,
    };
  }
  return null;
}

/* ---- Rule 2: Cash a known winner ----
   A card is a "known winner" when:
   - It's the highest unseen card in its suit, AND
   - The seat to your left can't trump (in suit contracts) — i.e. they're known out of trumps OR you're in NT.
   - You hold it (legal includes it).
   Conservative: only fires when we're confident. */
function ruleCash(legal, currentTrick, constraints, contract, mySeat, unseenBySuit) {
  // Only consider when we're on lead (no led suit yet)
  if (currentTrick.plays.length > 0) return null;
  const isNT = !contract || contract.denom === 'NT';
  const trump = isNT ? null : contract.denom;

  // For each suit we hold, find our highest card
  const bySuit = {};
  for (const c of legal) {
    if (!bySuit[c.suit] || RANK_VAL[c.rank] > RANK_VAL[bySuit[c.suit].rank]) {
      bySuit[c.suit] = c;
    }
  }

  // Candidates: cards that are the highest UNSEEN in their suit
  const candidates = [];
  for (const suit of SUIT_LIST) {
    if (!bySuit[suit]) continue;
    const myCard = bySuit[suit];
    // Find highest unseen rank in this suit by checking constraints
    let highestUnseen = null;
    for (const r of RANKS_DESC) {
      if (constraints.seen.has(r + suit)) continue;
      highestUnseen = r;
      break;
    }
    if (highestUnseen !== myCard.rank) continue;
    // In a suit contract, also require that no seat (other than mine + dummy if known) can trump
    if (trump && suit !== trump) {
      // Check if any other seat is known void in this suit but holds trumps
      // Conservative: only fire if NO seat shows any trump length OR it's the trump itself
      let canBeTrumped = false;
      for (const seat of POSITIONS) {
        if (seat === mySeat) continue;
        const outOfSuit = constraints[seat][suit].maxLen === 0;
        const hasTrump = constraints[seat][trump].maxLen > 0
          && constraints[seat][trump].minLen > 0; // proven to hold trump
        if (outOfSuit && hasTrump) { canBeTrumped = true; break; }
        // Even maxLen > 0 but unknown: could be trumped, so be conservative
        if (outOfSuit && constraints[seat][trump].maxLen > 0) { canBeTrumped = true; break; }
      }
      if (canBeTrumped) continue;
    }
    candidates.push(myCard);
  }
  if (candidates.length === 0) return null;
  // Prefer highest-ranked candidate (the more valuable to cash)
  const winner = candidates.sort((a, b) => RANK_VAL[b.rank] - RANK_VAL[a.rank])[0];
  return {
    card: winner,
    rule: 'cash',
    confidence: 'high',
    reasoning: `Cash ${winner.rank}${SYM[winner.suit]} — highest unseen in the suit, no opponent can beat it.`,
  };
}

/* ---- Rule 3: Third hand high ----
   When partner led and you're playing third, contribute the highest you can spare.
   Subtle: don't waste an honor unnecessarily. For v1, the heuristic is:
   - If the leader (partner) led a low spot and the dummy played low/medium, play your highest.
   - If dummy played a high honor, play low.
*/
function ruleThirdHandHigh(legal, currentTrick, mySeat, leadContext) {
  if (currentTrick.plays.length !== 2) return null;
  const ledSuit = currentTrick.plays[0].card.suit;
  const leader = currentTrick.plays[0].seat;
  const second = currentTrick.plays[1];
  // Verify partner led
  const myIdx = POS_INDEX[mySeat];
  const partnerSeat = POSITIONS[(myIdx + 2) % 4];
  if (leader !== partnerSeat) return null;

  const followers = legal.filter((c) => c.suit === ledSuit);
  if (followers.length === 0) return null;

  // If dummy played a high honor (>= J), don't bother going higher than needed
  const secondRank = RANK_VAL[second.card.rank];
  if (secondRank >= RANK_VAL.J) {
    // Play smallest card that still beats it, or smallest if you can't beat
    const beats = followers.filter((c) => RANK_VAL[c.rank] > secondRank);
    if (beats.length === 0) {
      const card = lowest(followers);
      return {
        card, rule: '3rd-hand-high',
        confidence: 'medium',
        reasoning: `Third hand: dummy's ${second.card.rank}${SYM[second.card.suit]} is high; can't beat it cheaply, save your honors and play low.`,
      };
    }
    const card = lowest(beats);
    return {
      card, rule: '3rd-hand-high',
      confidence: 'medium',
      reasoning: `Third hand: cover dummy's ${second.card.rank}${SYM[second.card.suit]} with the cheapest card that beats it (${card.rank}${SYM[card.suit]}).`,
    };
  }

  // Standard: play highest
  const card = highest(followers);
  return {
    card, rule: '3rd-hand-high',
    confidence: 'medium',
    reasoning: `Third hand high — partner led ${currentTrick.plays[0].card.rank}${SYM[ledSuit]}, dummy played low. Win or force declarer's honor with ${card.rank}${SYM[card.suit]}.`,
  };
}

/* ---- Rule 4: Second hand low ----
   You're 2nd to play (LHO of leader). Don't waste honors.
   Heuristic: if you have a small card in the led suit, play it. Don't split honors casually. */
function ruleSecondHandLow(legal, currentTrick, mySeat, leadContext) {
  if (currentTrick.plays.length !== 1) return null;
  const ledSuit = currentTrick.plays[0].card.suit;
  const leader = currentTrick.plays[0].seat;
  // We're 2nd hand iff leader is our RHO (we play right after them)
  const myIdx = POS_INDEX[mySeat];
  const rho = POSITIONS[(myIdx + 3) % 4];
  if (leader !== rho) return null;

  const followers = legal.filter((c) => c.suit === ledSuit);
  if (followers.length === 0) return null;

  // Play the lowest card we can. Exception: if we have a worthless singleton/doubleton that will
  // get stranded, but that's getting complex — keep it simple for v1.
  const card = lowest(followers);
  return {
    card, rule: '2nd-hand-low',
    confidence: 'medium',
    reasoning: `Second hand low — don't waste honors playing into uncertainty. Play ${card.rank}${SYM[card.suit]}.`,
  };
}

/* ---- Rule 4.5 (added v2.3.1): Leading ----
   When it's our turn AND no one has played yet this trick, we're on lead.
   Trick 1 → use the full opening-lead engine.
   Mid-hand → simpler heuristics:
     - Continue the suit you led last if you won and still have it.
     - Lead through declarer's bid suit toward dummy's weakness.
     - Otherwise lead low from your longest unbid suit.
   No partner-signal tracking yet — that's Phase 3 (signals layer). */
function ruleLeading(legal, currentTrick, mySeat, ownHand, contract, leadContext, auction, dealer, allTricks) {
  if (currentTrick.plays.length !== 0) return null;
  if (!ownHand) return null;

  // Trick 1: full opening-lead engine
  if ((allTricks?.length || 0) === 0) {
    const suits = { S: [], H: [], D: [], C: [] };
    for (const c of ownHand) suits[c.suit].push(c.rank);
    for (const s of SUIT_LIST) suits[s].sort((a, b) => RANK_VAL[b] - RANK_VAL[a]);
    const result = recommendOpeningLead({ contract, suits, auction: auction || [], dealer: dealer || 'N' });
    if (result?.primary && result.primary.lead) {
      const card = { suit: result.primary.suit, rank: result.primary.lead };
      return {
        card,
        rule: 'opening-lead',
        confidence: 'medium',
        reasoning: 'Opening lead: ' + (result.primary.reasons[0] || 'standard SAYC pick.'),
      };
    }
  }

  // Mid-hand lead: continue last-led suit if we won and still have it
  const lastTrick = allTricks && allTricks.length > 0 ? allTricks[allTricks.length - 1] : null;
  if (lastTrick && lastTrick.winner === mySeat) {
    const ledSuit = lastTrick.plays[0].card.suit;
    const stillHave = ownHand.filter((c) => c.suit === ledSuit);
    // Only continue if we still have ≥2 of the suit (signal: still working)
    if (stillHave.length >= 2) {
      const sorted = [...stillHave].sort((a, b) => RANK_VAL[b.rank] - RANK_VAL[a.rank]);
      // Lead low if our top is a spot card or already-played-around honor; otherwise lead the top
      const card = sorted[sorted.length - 1];
      return {
        card,
        rule: 'continue-suit',
        confidence: 'low',
        reasoning: `Continue ${SYM[ledSuit]} — won the last trick, still have ${stillHave.length} cards in suit. Partner can read the count.`,
      };
    }
  }

  // Lead through declarer's bid suit (low) toward dummy's weakness
  if (leadContext?.declarerSuits && leadContext.declarerSuits.length > 0) {
    for (const suit of leadContext.declarerSuits) {
      const cardsInSuit = ownHand.filter((c) => c.suit === suit);
      if (cardsInSuit.length === 0) continue;
      // Skip the trump suit — leading trumps from defenders is usually wrong
      if (contract && contract.denom !== 'NT' && suit === contract.denom) continue;
      const sorted = [...cardsInSuit].sort((a, b) => RANK_VAL[a.rank] - RANK_VAL[b.rank]);
      const card = sorted[0];
      return {
        card,
        rule: 'through-declarer',
        confidence: 'low',
        reasoning: `Lead low ${SYM[suit]} through declarer — opens up the layout, partner plays last.`,
      };
    }
  }

  // Fallback: low from longest non-trump suit
  const trumpDenom = contract && contract.denom !== 'NT' ? contract.denom : null;
  let longest = null, longestLen = 0;
  for (const suit of SUIT_LIST) {
    if (suit === trumpDenom) continue;
    const len = ownHand.filter((c) => c.suit === suit).length;
    if (len > longestLen) { longest = suit; longestLen = len; }
  }
  if (longest) {
    const cardsInSuit = ownHand.filter((c) => c.suit === longest)
      .sort((a, b) => RANK_VAL[a.rank] - RANK_VAL[b.rank]);
    return {
      card: cardsInSuit[0],
      rule: 'longest-suit',
      confidence: 'low',
      reasoning: `Low from your longest ${SYM[longest]} (${longestLen} cards) — establish length.`,
    };
  }

  return null;
}

/* ---- Top-level recommender ---- */
export function recommendNextCard({ constraints, currentTrick, mySeat, ownHand, contract, leadContext, unseenBySuit, auction, dealer, allTricks }) {
  const ledSuit = currentTrick.plays.length > 0 ? currentTrick.plays[0].card.suit : null;
  const legal = legalCards(constraints, mySeat, ledSuit, ownHand);
  if (legal.length === 0) return null;

  // Try rules in priority order
  for (const rule of [
    () => ruleForced(legal),
    () => ruleCash(legal, currentTrick, constraints, contract, mySeat, unseenBySuit),
    () => ruleThirdHandHigh(legal, currentTrick, mySeat, leadContext),
    () => ruleSecondHandLow(legal, currentTrick, mySeat, leadContext),
    () => ruleLeading(legal, currentTrick, mySeat, ownHand, contract, leadContext, auction, dealer, allTricks),
  ]) {
    const r = rule();
    if (r) return r;
  }

  return {
    card: null,
    rule: 'fallback',
    confidence: 'low',
    reasoning: 'No clear hint — heuristic engine doesn\'t see a forced play here. Use your own judgment.',
  };
}
