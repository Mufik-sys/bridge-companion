/* Opening-lead engine — heuristic guidance, not a card-play AI.

   Moved from BridgeTool.jsx in v2.3.1 so it can be imported by both
   LeadHelper (in BridgeTool.jsx) and the in-trick hint engine (engines/play.js).
   The bidding engine (recommendOpening, recommendResponseToOpen, etc.) is
   still in BridgeTool.jsx — that refactor is still deferred. */

import { isSeq, hasInternalSeq, RANK_VAL, deriveLeadContext } from '../sharedHelpers.js';

/* Tunable scoring constants. One place to retune the tradeoffs between
   shape, philosophy, and auction context. See v2.2 commit for the design
   discussion that landed these numbers. */
export const LEAD_WEIGHTS = {
  // Trump treatment
  trumpHonorSequence: -60,   // KQJ / QJT / KQ / QJ in trump — promotion disaster
  trumpIsolatedHonor: -25,
  trumpSmallOnly: -10,

  // Suit-contract base shapes (passive-lead philosophy)
  suitTopOf3Seq: 40,
  suitInternalSeq: 30,
  suitAK: 35,
  suit2HonorSeq: 25,
  suitSingleton: 35,
  suitDoubleton: 5,
  suitDoubletonQ: -20,       // Qx trap (added on top of suitDoubleton)
  suitDoubletonJ: -15,       // Jx trap
  suit4ToHonor: 5,
  suit3ToHonor: -5,
  suit3Small: 0,
  suitDefault: -5,

  // NT base shapes (active-lead philosophy)
  ntTopOf3Seq: 40,
  ntInternalSeq: 30,
  ntAK: 15,
  nt4thBest: 25,
  nt4ToHonor: 5,
  nt3ToHonor: -5,
  ntDoubleton: -10,
  ntSingleton: -20,
  ntDefault: -10,

  // Auction-context modifiers
  partnerSuit: 50,
  declarerSuit: -25,
  unbidBonus: { 1: 30, 2: 20, 3: 10 },
  defenderTakeoutBonus: 10,
  declarerTakeoutBonus: 5,

  // Partner-passed-throughout
  partnerPassSingleton: -20,
  partnerPassDoubleton: -8,
};

export function analyzeSuit(holding, denom, ctx) {
  const len = holding.length;
  if (len === 0) return null;
  const W = LEAD_WEIGHTS;
  const reasons = [];
  let lead = null;
  let score = 0;
  const top = holding[0];

  // -------- Trump suit treatment --------
  if (ctx.isTrump) {
    if (isSeq(holding.slice(0, 3), 3)
        || (isSeq(holding.slice(0, 2), 2) && RANK_VAL[top] >= 11)) {
      score += W.trumpHonorSequence;
      const seqLen = isSeq(holding.slice(0, 3), 3) ? 3 : 2;
      reasons.push(`Trump suit AND honor sequence (${holding.slice(0, seqLen).join('')}) — leading from this almost certainly promotes declarer's small trumps. Almost always wrong.`);
      lead = holding[len - 1];
    } else if (RANK_VAL[top] >= 11) {
      score += W.trumpIsolatedHonor;
      reasons.push(`Trump suit with an isolated honor (${top}) — risks giving a trick; lead a small trump if you must.`);
      lead = holding[len - 1];
    } else {
      score += W.trumpSmallOnly;
      reasons.push('Trump suit, small only — passive trump lead is OK against cross-ruff or to cut down ruffs.');
      lead = holding[len - 1];
    }
  } else if (ctx.isNT) {
    // -------- NT philosophy: active leads, set up your long suit --------
    if (len === 1) {
      score += W.ntSingleton;
      reasons.push("Singleton in NT — usually wrong; sets up declarer's long suit.");
      lead = top;
    } else if (len === 2) {
      score += W.ntDoubleton;
      reasons.push('Doubleton in NT — generally poor unless partner bid the suit.');
      lead = top;
    } else if (isSeq(holding.slice(0, 3), 3)) {
      score += W.ntTopOf3Seq;
      reasons.push(`Top of a 3-card sequence (${holding.slice(0, 3).join('')}) — strong NT lead.`);
      lead = top;
    } else {
      const internal = hasInternalSeq(holding);
      if (internal) {
        score += W.ntInternalSeq;
        reasons.push(`Internal sequence — lead the ${internal.seqStart} (inner run; ${internal.topHonor} as stopper).`);
        lead = internal.seqStart;
      } else if (top === 'A' && holding[1] === 'K') {
        score += W.ntAK;
        reasons.push('AK in NT — leading the A and continuing can establish length tricks.');
        lead = 'A';
      } else if (len >= 4) {
        score += W.nt4thBest;
        if (RANK_VAL[top] >= 11) score += W.nt4ToHonor;
        lead = holding[3];
        reasons.push(`4th best from your longest/strongest suit — the standard NT lead. Lead the ${lead}.`);
      } else if (len === 3 && RANK_VAL[top] >= 11) {
        score += W.nt3ToHonor;
        reasons.push(`Three to an honor in NT — lead low (${holding[2]}) to preserve the honor as a stopper.`);
        lead = holding[2];
      } else {
        score += W.ntDefault;
        reasons.push(`Three small in NT — top of nothing (${top}); not preferred against NT.`);
        lead = top;
      }
    }
  } else {
    // -------- Suit-contract philosophy: passive leads --------
    if (len === 1) {
      score += W.suitSingleton;
      reasons.push(`Singleton ${top} — strong lead in a suit contract; aiming for a ruff if partner has an entry.`);
      lead = top;
      if (ctx.partnerPassedThroughout) {
        score += W.partnerPassSingleton;
        reasons.push('Partner passed throughout — unlikely to have an entry to give the ruff. Devalued.');
      }
    } else if (isSeq(holding.slice(0, 3), 3)) {
      score += W.suitTopOf3Seq;
      reasons.push(`Top of a 3-card sequence (${holding.slice(0, 3).join('')}) — safest and most informative lead.`);
      lead = top;
    } else {
      const internal = hasInternalSeq(holding);
      if (internal) {
        score += W.suitInternalSeq;
        reasons.push(`Internal sequence — lead the ${internal.seqStart} (inner run; ${internal.topHonor} as stopper).`);
        lead = internal.seqStart;
      } else if (top === 'A' && holding[1] === 'K') {
        score += W.suitAK;
        reasons.push('AK combination — SAYC standard is to lead the A from AK against suit contracts.');
        lead = 'A';
      } else if (isSeq(holding.slice(0, 2), 2) && RANK_VAL[top] >= 11) {
        score += W.suit2HonorSeq;
        reasons.push(`Top of a 2-card honor sequence (${holding.slice(0, 2).join('')}).`);
        lead = top;
      } else if (len === 2) {
        score += W.suitDoubleton;
        if (top === 'Q') {
          score += W.suitDoubletonQ;
          reasons.push(`Doubleton Q${holding[1]} — Qx is a classic trap lead in suit contracts; often costs a trick.`);
        } else if (top === 'J') {
          score += W.suitDoubletonJ;
          reasons.push(`Doubleton J${holding[1]} — Jx can hand declarer a free finesse.`);
        } else {
          reasons.push(`Doubleton ${holding.join('')} — top of doubleton can set up a ruff in a suit contract.`);
        }
        lead = top;
        if (ctx.partnerPassedThroughout) {
          score += W.partnerPassDoubleton;
          reasons.push('Partner passed throughout — ruff hopes are slim without an entry.');
        }
      } else if (len >= 4 && RANK_VAL[top] >= 11) {
        score += W.suit4ToHonor;
        lead = holding[len - 1];
        reasons.push(`Four+ to an unsupported honor — lead low (${lead}); leading the honor often gives a trick.`);
      } else if (len === 3 && RANK_VAL[top] >= 11) {
        score += W.suit3ToHonor;
        reasons.push(`Three to an honor — lead low (${holding[2]}) per textbook.`);
        lead = holding[2];
      } else if (len === 3) {
        score += W.suit3Small;
        reasons.push(`Three small (${holding.join('')}) — top of nothing; most pairs lead top of three small.`);
        lead = top;
      } else {
        score += W.suitDefault;
        lead = holding[len - 1];
        reasons.push(`Default — lead low (${lead}).`);
      }
    }
  }

  // -------- Auction-context modifiers --------
  if (ctx.isPartnerSuit) {
    score += W.partnerSuit;
    reasons.unshift('Partner bid this suit — strongly preferred lead.');
  }
  if (ctx.isDeclarerSuit) {
    score += W.declarerSuit;
    reasons.unshift('Declarer/dummy bid this suit — generally avoid leading it.');
  }
  if (ctx.isUnbid && !ctx.isTrump) {
    const bonus = W.unbidBonus[ctx.unbidCount] || 0;
    if (bonus > 0) {
      score += bonus;
      const label = ctx.unbidCount === 1 ? 'only unbid suit' : `unbid (${ctx.unbidCount} of 4)`;
      reasons.unshift(`This is the ${label} — a relatively safe lead in a contested auction.`);
    }
    if (ctx.defenderTookOut) {
      score += W.defenderTakeoutBonus;
      reasons.push('Defender side made a takeout-shape X — partner likely has length here.');
    }
    if (ctx.declarerTookOut) {
      score += W.declarerTakeoutBonus;
      reasons.push('Declarer side made a takeout-shape X — declarer/dummy hold length here.');
    }
  }

  return { suit: denom, holding, lead, score, reasons };
}

export function recommendOpeningLead({ contract, suits, auction = [], dealer = 'N' }) {
  const leadCtx = deriveLeadContext(auction, dealer, contract);
  const isNT = contract && contract.denom === 'NT';
  const trumpDenom = !isNT && contract ? contract.denom : null;
  const results = [];
  for (const denom of ['S', 'H', 'D', 'C']) {
    const r = analyzeSuit(suits[denom] || [], denom, {
      isNT,
      isTrump: denom === trumpDenom,
      isPartnerSuit: leadCtx.partnerSuits.includes(denom),
      isDeclarerSuit: leadCtx.declarerSuits.includes(denom),
      isUnbid: leadCtx.unbidSuits.includes(denom),
      unbidCount: leadCtx.unbidSuits.length,
      partnerPassedThroughout: leadCtx.partnerPassedThroughout,
      defenderTookOut: leadCtx.doubles.byDefenderSide,
      declarerTookOut: leadCtx.doubles.byDeclarerSide,
    });
    if (r) results.push(r);
  }
  results.sort((a, b) => b.score - a.score);
  return { primary: results[0], alternatives: results.slice(1), contextSummary: leadCtx.summary, leadContext: leadCtx };
}
