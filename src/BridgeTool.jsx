import { useState, useMemo } from 'react';
import { RotateCcw, Info, Settings2, ChevronDown, ChevronUp } from 'lucide-react';
import {
  DENOMS, SYM, SUIT_LIST, POSITIONS, POS_INDEX,
  PlayerColors, parseHolding,
  deriveContract,
} from './sharedHelpers.js';
import { recommendOpeningLead } from './engines/lead.js';
import {
  HonorTile, AuctionDisplay, BidKeypad, Toggle, Collapsible,
  SuitInput, ContractPicker,
} from './uiComponents.jsx';
import LivePlayTab from './LivePlayTab.jsx';

/* Default conventions — both on by user's selection */
const DEFAULT_CONV = { jacobyTransfers: true, newMinorForcing: true };

/* =========================================================
   SAYC BIDDING ENGINE
   ========================================================= */

const isBalanced = (s, h, d, c) => {
  const sorted = [s, h, d, c].sort((a, b) => b - a);
  if (sorted[0] === 4 && sorted[3] >= 3) return true;            // 4-3-3-3
  if (sorted[0] === 4 && sorted[1] === 4 && sorted[2] === 3 && sorted[3] === 2) return true;
  if (sorted[0] === 5 && sorted[1] === 3 && sorted[2] === 3 && sorted[3] === 2) return true;
  return false;
};

function recommendOpening(hand) {
  const { hcp, s, h, d, c } = hand;
  const bal = isBalanced(s, h, d, c);

  if (hcp >= 22)
    return { bid: { type: 'bid', level: 2, denom: 'C' }, explanation: 'Strong opening — 22+ HCP. Open 2♣ — the only forcing opening in SAYC. Plan to show your real suit on the next round.' };
  if (hcp >= 20 && hcp <= 21 && bal)
    return { bid: { type: 'bid', level: 2, denom: 'NT' }, explanation: '20–21 HCP, balanced shape. Open 2NT.' };
  if (hcp >= 15 && hcp <= 17 && bal)
    return { bid: { type: 'bid', level: 1, denom: 'NT' }, explanation: '15–17 HCP, balanced shape. Open 1NT.' };

  if (hcp >= 13) {
    if (s >= 5 && s >= h)
      return { bid: { type: 'bid', level: 1, denom: 'S' }, explanation: 'Opening values with 5+ spades. Open 1♠. (With 5–5 in the majors, open the higher — spades.)' };
    if (h >= 5)
      return { bid: { type: 'bid', level: 1, denom: 'H' }, explanation: 'Opening values with 5+ hearts (and fewer spades). Open 1♥.' };
    if (d > c || (d === c && d >= 4))
      return { bid: { type: 'bid', level: 1, denom: 'D' }, explanation: 'Opening values, no 5-card major. Open the longer minor — 1♦. (With 4–4 in the minors, prefer 1♦.)' };
    return { bid: { type: 'bid', level: 1, denom: 'C' }, explanation: 'Opening values, no 5-card major. With 3–3 in the minors (or longer clubs), open 1♣.' };
  }

  // Rule of 20 — light openings
  const sorted = [s, h, d, c].sort((a, b) => b - a);
  if (hcp >= 11) {
    const r20 = hcp + sorted[0] + sorted[1];
    if (r20 >= 20) {
      if (s >= 5 && s >= h) return { bid: { type: 'bid', level: 1, denom: 'S' }, explanation: `Rule of 20 satisfied (${hcp} HCP + ${sorted[0]} + ${sorted[1]} = ${r20}). Open 1♠.` };
      if (h >= 5) return { bid: { type: 'bid', level: 1, denom: 'H' }, explanation: `Rule of 20 satisfied. Open 1♥.` };
      if (d >= c) return { bid: { type: 'bid', level: 1, denom: 'D' }, explanation: `Rule of 20 satisfied. Open 1♦.` };
      return { bid: { type: 'bid', level: 1, denom: 'C' }, explanation: `Rule of 20 satisfied. Open 1♣.` };
    }
  }

  // Weak twos
  if (hcp >= 5 && hcp <= 11) {
    if (s === 6) return { bid: { type: 'bid', level: 2, denom: 'S' }, explanation: 'Weak 2♠ — 5–11 HCP with a 6-card spade suit. (Prefer 2 of the top 3 honors; avoid with a side 4-card major.)' };
    if (h === 6) return { bid: { type: 'bid', level: 2, denom: 'H' }, explanation: 'Weak 2♥ — 5–11 HCP with a 6-card heart suit.' };
    if (d === 6) return { bid: { type: 'bid', level: 2, denom: 'D' }, explanation: 'Weak 2♦ — 5–11 HCP with a 6-card diamond suit.' };
  }

  // 3-level preempts
  if (hcp >= 5 && hcp <= 10) {
    for (const denom of ['S', 'H', 'D', 'C']) {
      const len = { S: s, H: h, D: d, C: c }[denom];
      if (len === 7) return { bid: { type: 'bid', level: 3, denom }, explanation: `Preempt 3${SYM[denom]} — 7-card suit with weak hand. Vulnerability matters: ideally 6+ playing tricks vul, 5+ non-vul.` };
    }
  }

  return { bid: { type: 'pass' }, explanation: `${hcp} HCP and no preemptive shape. Pass.` };
}

function recommendResponseToOpen(hand, openBid, conv = DEFAULT_CONV) {
  const { hcp, s, h, d, c } = hand;
  const lengths = { S: s, H: h, D: d, C: c };

  // 1NT opening
  if (openBid.type === 'bid' && openBid.level === 1 && openBid.denom === 'NT') {
    const jt = conv.jacobyTransfers;
    if (hcp <= 7) {
      if (jt && s >= 5) return { bid: { type: 'bid', level: 2, denom: 'H' }, explanation: '0–7 HCP with 5+ spades — Jacoby transfer 2♥. Plan to pass partner\'s 2♠ (sign-off).' };
      if (jt && h >= 5) return { bid: { type: 'bid', level: 2, denom: 'D' }, explanation: '0–7 HCP with 5+ hearts — Jacoby transfer 2♦. Plan to pass partner\'s 2♥ (sign-off).' };
      if (!jt && s >= 5) return { bid: { type: 'bid', level: 2, denom: 'S' }, explanation: '0–7 HCP with 5+ spades — sign-off in 2♠ (transfers off).' };
      if (!jt && h >= 5) return { bid: { type: 'bid', level: 2, denom: 'H' }, explanation: '0–7 HCP with 5+ hearts — sign-off in 2♥ (transfers off).' };
      return { bid: { type: 'pass' }, explanation: '0–7 HCP, no long major — pass 1NT.' };
    }
    if (hcp <= 9) {
      if (jt && s >= 5) return { bid: { type: 'bid', level: 2, denom: 'H' }, explanation: '8–9 HCP with 5+ spades — transfer 2♥, then 2NT to invite (or 3♠ with 6+).' };
      if (jt && h >= 5) return { bid: { type: 'bid', level: 2, denom: 'D' }, explanation: '8–9 HCP with 5+ hearts — transfer 2♦, then 2NT to invite (or 3♥ with 6+).' };
      if (s === 4 || h === 4) return { bid: { type: 'bid', level: 2, denom: 'C' }, explanation: '8–9 HCP with a 4-card major — bid 2♣ Stayman, looking for an 8-card major fit.' };
      return { bid: { type: 'bid', level: 2, denom: 'NT' }, explanation: 'Invitational 8–9 HCP, no 4-card major — raise to 2NT.' };
    }
    if (hcp <= 14) {
      if (jt && s >= 5) return { bid: { type: 'bid', level: 2, denom: 'H' }, explanation: '10–14 HCP with 5+ spades — transfer 2♥; then 3NT (5 spades) or 4♠ (6+ spades) on the next round.' };
      if (jt && h >= 5) return { bid: { type: 'bid', level: 2, denom: 'D' }, explanation: '10–14 HCP with 5+ hearts — transfer 2♦; then 3NT (5 hearts) or 4♥ (6+ hearts) on the next round.' };
      if (!jt && s >= 5) return { bid: { type: 'bid', level: 4, denom: 'S' }, explanation: '10–14 HCP with 5+ spades — bid 4♠ (transfers off).' };
      if (!jt && h >= 5) return { bid: { type: 'bid', level: 4, denom: 'H' }, explanation: '10–14 HCP with 5+ hearts — bid 4♥ (transfers off).' };
      if (s === 4 || h === 4) return { bid: { type: 'bid', level: 2, denom: 'C' }, explanation: 'Game values with a 4-card major — 2♣ Stayman first.' };
      return { bid: { type: 'bid', level: 3, denom: 'NT' }, explanation: '10–14 HCP, no 5-card major — bid 3NT.' };
    }
    if (hcp <= 17) return { bid: { type: 'bid', level: 4, denom: 'NT' }, explanation: '15–17 HCP — quantitative 4NT inviting slam. Partner accepts with a maximum.' };
    return { bid: { type: 'bid', level: 6, denom: 'NT' }, explanation: '18+ HCP opposite 1NT — bid 6NT directly (or explore via Stayman/transfers if a major fit is possible).' };
  }

  // 1♥ / 1♠ openings
  if (openBid.type === 'bid' && openBid.level === 1 && (openBid.denom === 'H' || openBid.denom === 'S')) {
    const trump = openBid.denom;
    const tLen = lengths[trump];

    if (hcp <= 5) return { bid: { type: 'pass' }, explanation: '0–5 HCP — pass partner\'s 1-of-a-major opening.' };
    if (hcp <= 9) {
      if (tLen >= 3) return { bid: { type: 'bid', level: 2, denom: trump }, explanation: `6–9 HCP with ${tLen} trumps — single raise to 2${SYM[trump]}.` };
      if (trump === 'H' && s >= 4) return { bid: { type: 'bid', level: 1, denom: 'S' }, explanation: '6+ HCP with 4+ spades — bid 1♠ (a new suit by responder is forcing one round).' };
      return { bid: { type: 'bid', level: 1, denom: 'NT' }, explanation: '6–9 HCP, no fit, no biddable major — bid 1NT.' };
    }
    if (hcp <= 12) {
      if (tLen >= 3) return { bid: { type: 'bid', level: 3, denom: trump }, explanation: `10–12 HCP with ${tLen} trumps — limit raise to 3${SYM[trump]} (invitational to game).` };
      if (trump === 'H' && s >= 4) return { bid: { type: 'bid', level: 1, denom: 'S' }, explanation: '10–12 HCP with 4+ spades — bid 1♠ (forcing).' };
      const minor = c >= d ? 'C' : 'D';
      const minorLen = lengths[minor];
      if (minorLen >= 4) return { bid: { type: 'bid', level: 2, denom: minor }, explanation: `10+ HCP — bid 2${SYM[minor]} (a new suit at the 2-level shows opening values, ~10+ HCP).` };
      return { bid: { type: 'bid', level: 1, denom: 'NT' }, explanation: '10–12 HCP, no fit, no biddable suit at the 2-level — 1NT (bid more aggressively next round).' };
    }
    // 13+
    if (tLen >= 4) return { bid: { type: 'bid', level: 4, denom: trump }, explanation: `13+ HCP with 4+ trumps — bid game (4${SYM[trump]}). With slam interest, use Jacoby 2NT (if you play it).` };
    if (tLen === 3) return { bid: { type: 'bid', level: 2, denom: 'NT' }, explanation: '13–15 HCP with 3-card support, balanced — 2NT (forcing in modern SAYC).' };
    if (trump === 'H' && s >= 4) return { bid: { type: 'bid', level: 1, denom: 'S' }, explanation: '13+ HCP with 4+ spades — bid 1♠; you\'ll force to game on the next round.' };
    const minor = c >= d ? 'C' : 'D';
    if (lengths[minor] >= 4) return { bid: { type: 'bid', level: 2, denom: minor }, explanation: `13+ HCP — 2${SYM[minor]} (forcing one round; drive to game on the next bid).` };
    return { bid: { type: 'bid', level: 2, denom: 'NT' }, explanation: '13+ HCP, balanced, no major fit — 2NT.' };
  }

  // 1♣ / 1♦ openings
  if (openBid.type === 'bid' && openBid.level === 1 && (openBid.denom === 'C' || openBid.denom === 'D')) {
    const minor = openBid.denom;
    const mLen = lengths[minor];

    if (hcp <= 5) return { bid: { type: 'pass' }, explanation: '0–5 HCP — pass.' };

    if (hcp >= 6) {
      if (h >= 4 && h >= s) return { bid: { type: 'bid', level: 1, denom: 'H' }, explanation: '6+ HCP with 4+ hearts — bid 1♥. ("Up the line": with both 4-card majors, hearts first.)' };
      if (s >= 4) return { bid: { type: 'bid', level: 1, denom: 'S' }, explanation: '6+ HCP with 4+ spades (and fewer hearts) — bid 1♠.' };
    }
    if (hcp <= 9) {
      if (minor === 'C' && c >= 5) return { bid: { type: 'bid', level: 2, denom: 'C' }, explanation: '6–9 HCP, 5+ clubs, no 4-card major — single raise to 2♣.' };
      if (minor === 'D' && d >= 4) return { bid: { type: 'bid', level: 2, denom: 'D' }, explanation: '6–9 HCP, 4+ diamonds, no 4-card major — single raise to 2♦.' };
      return { bid: { type: 'bid', level: 1, denom: 'NT' }, explanation: '6–9 HCP, no 4-card major, no real fit — 1NT.' };
    }
    if (hcp <= 12) return { bid: { type: 'bid', level: 2, denom: 'NT' }, explanation: '10–12 HCP, no 4-card major, balanced with stoppers — 2NT (invitational).' };
    return { bid: { type: 'bid', level: 3, denom: 'NT' }, explanation: '13+ HCP, balanced, all suits stopped — 3NT.' };
  }

  // 2♣ strong
  if (openBid.type === 'bid' && openBid.level === 2 && openBid.denom === 'C') {
    return { bid: { type: 'bid', level: 2, denom: 'D' }, explanation: 'Standard response to 2♣ in SAYC is 2♦ "waiting", regardless of strength. Tell partner about your hand on the next round.' };
  }

  // 2NT (20-21 balanced)
  if (openBid.type === 'bid' && openBid.level === 2 && openBid.denom === 'NT') {
    if (hcp <= 4) return { bid: { type: 'pass' }, explanation: '0–4 HCP — pass 2NT.' };
    if (s === 4 || h === 4) return { bid: { type: 'bid', level: 3, denom: 'C' }, explanation: '5+ HCP with a 4-card major — 3♣ Stayman.' };
    if (hcp >= 11) return { bid: { type: 'bid', level: 6, denom: 'NT' }, explanation: '11+ HCP opposite 20–21 = 31+ combined — bid 6NT.' };
    return { bid: { type: 'bid', level: 3, denom: 'NT' }, explanation: '5–10 HCP, no 4-card major — bid 3NT.' };
  }

  // Weak twos (2♦/2♥/2♠)
  if (openBid.type === 'bid' && openBid.level === 2 && (openBid.denom === 'D' || openBid.denom === 'H' || openBid.denom === 'S')) {
    const wDenom = openBid.denom;
    const wLen = lengths[wDenom];
    if (hcp >= 14 && wLen >= 3) return { bid: { type: 'bid', level: 4, denom: wDenom }, explanation: `Likely game with ${wLen} trumps and ${hcp} HCP — bid 4${SYM[wDenom]}.` };
    if (hcp >= 16 && wLen <= 1) return { bid: { type: 'bid', level: 2, denom: 'NT' }, explanation: '16+ HCP with shortness in trumps — bid 2NT (feature-asking / Ogust, depending on your method).' };
    return { bid: { type: 'pass' }, explanation: 'Pass partner\'s preempt unless you have game-going values.' };
  }

  // 3-level preempts
  if (openBid.type === 'bid' && openBid.level === 3) {
    if (hcp >= 16 && lengths[openBid.denom] >= 1) return { bid: { type: 'bid', level: 4, denom: openBid.denom }, explanation: 'Strong hand opposite preempt with at least one trump — raise to game.' };
    return { bid: { type: 'pass' }, explanation: 'Respect the preempt unless you have a clear game.' };
  }

  return null;
}

function recommendOvercall(hand, oppOpen) {
  const { hcp, s, h, d, c } = hand;
  const lengths = { S: s, H: h, D: d, C: c };

  if (oppOpen.type !== 'bid') return { bid: { type: 'pass' }, explanation: 'Pass — wait for clearer auction.' };

  // Over 1NT opening — unusual NT, etc., basic guidance only
  if (oppOpen.level === 1 && oppOpen.denom === 'NT') {
    if (hcp >= 15) return { bid: { type: 'dbl' }, explanation: 'Over a 15–17 1NT, double shows ~15+ HCP for penalty in basic SAYC. (Some pairs play conventional 2-suiters; check partnership agreements.)' };
    if (s >= 5 && h >= 5) return { bid: { type: 'bid', level: 2, denom: 'C' }, explanation: '5–5 in the majors — bid Cappelletti/Hamilton 2♣ if you play it; otherwise 2♥/2♠ natural.' };
    return { bid: { type: 'pass' }, explanation: 'Pass — direct overcalls of 1NT are dangerous without conventional methods or extra shape.' };
  }

  if (oppOpen.level === 1) {
    const oppSuit = oppOpen.denom;
    const oppLen = lengths[oppSuit];

    // 1NT overcall
    if (hcp >= 15 && hcp <= 18 && isBalanced(s, h, d, c) && oppLen >= 1) {
      return { bid: { type: 'bid', level: 1, denom: 'NT' }, explanation: '15–18 HCP, balanced, with at least one stopper in opener\'s suit — 1NT overcall.' };
    }

    // Suit overcall — try each non-opener suit, prefer majors and longer/higher
    const candidates = [];
    for (const denom of ['S', 'H', 'D', 'C']) {
      if (denom === oppSuit) continue;
      const len = lengths[denom];
      if (len < 5) continue;
      const overLevel = DENOMS.indexOf(denom) > DENOMS.indexOf(oppSuit) ? 1 : 2;
      candidates.push({ denom, len, level: overLevel });
    }
    // pick longest suit; tie → higher ranking
    candidates.sort((a, b) => (b.len - a.len) || (DENOMS.indexOf(b.denom) - DENOMS.indexOf(a.denom)));

    if (candidates.length) {
      const c0 = candidates[0];
      if (c0.level === 1 && hcp >= 8 && hcp <= 16) {
        return { bid: { type: 'bid', level: 1, denom: c0.denom }, explanation: `${hcp} HCP with ${c0.len} ${SYM[c0.denom]} — 1${SYM[c0.denom]} overcall. Suit quality matters: ideally KQT-x-x or better.` };
      }
      if (c0.level === 2 && hcp >= 11 && hcp <= 16) {
        return { bid: { type: 'bid', level: 2, denom: c0.denom }, explanation: `${hcp} HCP with ${c0.len} ${SYM[c0.denom]} — 2${SYM[c0.denom]} overcall. A 2-level overcall promises a good 5-card+ suit and ~11+ HCP.` };
      }
    }

    // Takeout double
    const others = SUIT_LIST.filter((x) => x !== oppSuit);
    const allOthersThree = others.every((x) => lengths[x] >= 3);
    if (hcp >= 12 && oppLen <= 2 && allOthersThree) {
      return { bid: { type: 'dbl' }, explanation: `Takeout double — 12+ HCP, short in opener\'s suit (${oppLen}), 3+ in each of the other suits.` };
    }
    if (hcp >= 17) {
      return { bid: { type: 'dbl' }, explanation: '17+ HCP — too strong to overcall directly. Start with a takeout double, then bid your suit on the next round to show extras.' };
    }
  }

  return { bid: { type: 'pass' }, explanation: 'No clear overcall or takeout double — pass.' };
}

/* Auction context — who bid what, in what role */
function analyzeAuction(auction, dealer) {
  const dealerIdx = POS_INDEX[dealer];
  const myIdx = POS_INDEX.S;
  const partnerIdx = (myIdx + 2) % 4;
  const lhoIdx = (myIdx + 3) % 4;
  const rhoIdx = (myIdx + 1) % 4;
  const turnIdx = (dealerIdx + auction.length) % 4;

  const byPos = { N: [], E: [], S: [], W: [] };
  for (let i = 0; i < auction.length; i++) {
    const seat = POSITIONS[(dealerIdx + i) % 4];
    byPos[seat].push(auction[i]);
  }

  const realBids = (arr) => arr.filter((b) => b.type === 'bid');
  const myReal = realBids(byPos.S);
  const partnerReal = realBids(byPos[POSITIONS[partnerIdx]]);
  const lhoReal = realBids(byPos[POSITIONS[lhoIdx]]);
  const rhoReal = realBids(byPos[POSITIONS[rhoIdx]]);

  let firstBidder = -1, firstBid = null, firstIdx = -1;
  for (let i = 0; i < auction.length; i++) {
    if (auction[i].type !== 'pass') { firstBidder = (dealerIdx + i) % 4; firstBid = auction[i]; firstIdx = i; break; }
  }

  const oppActed = lhoReal.length > 0 || rhoReal.length > 0
    || byPos[POSITIONS[lhoIdx]].some((b) => b.type === 'dbl' || b.type === 'rdbl')
    || byPos[POSITIONS[rhoIdx]].some((b) => b.type === 'dbl' || b.type === 'rdbl');

  return {
    dealerIdx, myIdx, partnerIdx, lhoIdx, rhoIdx, turnIdx,
    isMyTurn: turnIdx === myIdx,
    myBids: byPos.S, partnerBids: byPos[POSITIONS[partnerIdx]],
    lhoBids: byPos[POSITIONS[lhoIdx]], rhoBids: byPos[POSITIONS[rhoIdx]],
    myReal, partnerReal, oppActed,
    firstBidder, firstBid, firstIdx,
  };
}

/* Responder's rebid — partner opened, you responded, partner rebid */
function recommendResponderRebid(hand, ctx, conv) {
  const { hcp, s, h, d, c } = hand;
  const lengths = { S: s, H: h, D: d, C: c };
  const pOpen = ctx.partnerReal[0];
  const pRebid = ctx.partnerReal[1];
  const myFirst = ctx.myReal[0];
  if (!pOpen || !pRebid || !myFirst) return null;

  // After Jacoby Transfer accepted: partner 1NT, my 2D/2H, partner 2H/2S
  if (conv.jacobyTransfers
      && pOpen.level === 1 && pOpen.denom === 'NT'
      && myFirst.level === 2 && (myFirst.denom === 'D' || myFirst.denom === 'H')
      && pRebid.level === 2
      && ((myFirst.denom === 'D' && pRebid.denom === 'H') || (myFirst.denom === 'H' && pRebid.denom === 'S'))) {
    const M = myFirst.denom === 'D' ? 'H' : 'S';
    const tLen = lengths[M];
    if (hcp <= 7) return { bid: { type: 'pass' }, explanation: `0–7 HCP — pass partner's ${pRebid.level}${SYM[pRebid.denom]} acceptance. Sign-off in your major.` };
    if (hcp <= 9 && tLen >= 6) return { bid: { type: 'bid', level: 3, denom: M }, explanation: `8–9 HCP with 6+ ${SYM[M]} — invitational 3${SYM[M]}. Partner passes with min, bids game with max.` };
    if (hcp <= 9) return { bid: { type: 'bid', level: 2, denom: 'NT' }, explanation: `8–9 HCP with 5 ${SYM[M]} — 2NT invitational. Partner picks between 3NT/pass with min and 4${SYM[M]}/3NT with max.` };
    if (hcp <= 14 && tLen >= 6) return { bid: { type: 'bid', level: 4, denom: M }, explanation: `10–14 HCP with 6+ ${SYM[M]} — bid game 4${SYM[M]}.` };
    if (hcp <= 14) return { bid: { type: 'bid', level: 3, denom: 'NT' }, explanation: `10–14 HCP with 5 ${SYM[M]} — 3NT, offering partner the choice (pass with 2 trumps, 4${SYM[M]} with 3).` };
    return { bid: { type: 'bid', level: 4, denom: 'NT' }, explanation: `15+ HCP — slammish; 4NT quantitative or start a control sequence.` };
  }

  // After Stayman: partner 1NT, my 2C, partner 2D/2H/2S
  if (pOpen.level === 1 && pOpen.denom === 'NT'
      && myFirst.level === 2 && myFirst.denom === 'C'
      && pRebid.level === 2 && (pRebid.denom === 'D' || pRebid.denom === 'H' || pRebid.denom === 'S')) {
    const reply = pRebid.denom;
    if (reply !== 'D') {
      const fit = lengths[reply] >= 4;
      if (fit) {
        if (hcp <= 9) return { bid: { type: 'bid', level: 3, denom: reply }, explanation: `Partner showed 4 ${SYM[reply]}; you have 4+ — invitational 3${SYM[reply]} with 8–9 HCP.` };
        return { bid: { type: 'bid', level: 4, denom: reply }, explanation: `Game in your 4-4 ${SYM[reply]} fit — bid 4${SYM[reply]}.` };
      }
      if (hcp <= 9) return { bid: { type: 'bid', level: 2, denom: 'NT' }, explanation: `No ${SYM[reply]} fit — 2NT invitational with 8–9 HCP.` };
      return { bid: { type: 'bid', level: 3, denom: 'NT' }, explanation: `No major fit — 3NT with game values.` };
    }
    if (hcp <= 9) return { bid: { type: 'bid', level: 2, denom: 'NT' }, explanation: `Partner denied a 4-card major (2♦) — 2NT invitational.` };
    return { bid: { type: 'bid', level: 3, denom: 'NT' }, explanation: `Partner denied a 4-card major (2♦) — 3NT.` };
  }

  // After 1m – 1M – 1NT : New Minor Forcing / Checkback Stayman
  if (conv.newMinorForcing
      && pOpen.level === 1 && (pOpen.denom === 'C' || pOpen.denom === 'D')
      && myFirst.level === 1 && (myFirst.denom === 'H' || myFirst.denom === 'S')
      && pRebid.level === 1 && pRebid.denom === 'NT') {
    const myMajor = myFirst.denom;
    const otherMajor = myMajor === 'H' ? 'S' : 'H';
    const newMinor = pOpen.denom === 'C' ? 'D' : 'C';
    if (hcp <= 7) return { bid: { type: 'pass' }, explanation: `7- HCP — pass 1NT. Partner has 12–14 balanced.` };
    if (hcp <= 10) {
      if (lengths[myMajor] >= 6) return { bid: { type: 'bid', level: 2, denom: myMajor }, explanation: `8–10 HCP with 6+ ${SYM[myMajor]} — 2${SYM[myMajor]} invitational.` };
      return { bid: { type: 'bid', level: 2, denom: 'NT' }, explanation: `8–10 HCP balanced — 2NT invitational.` };
    }
    if (lengths[myMajor] >= 5 || lengths[otherMajor] >= 4) {
      return { bid: { type: 'bid', level: 2, denom: newMinor }, explanation: `11+ HCP with a major-oriented hand — 2${SYM[newMinor]} New Minor Forcing / Checkback. Asks partner for 3-card support of your major or a 4-card other major; otherwise partner bids 2NT/3NT.` };
    }
    if (lengths[myMajor] >= 6) return { bid: { type: 'bid', level: 4, denom: myMajor }, explanation: `11+ HCP with 6+ ${SYM[myMajor]} — bid game 4${SYM[myMajor]}.` };
    return { bid: { type: 'bid', level: 3, denom: 'NT' }, explanation: `11+ HCP balanced — 3NT.` };
  }

  return { bid: null, explanation: 'Auction past the engine\'s rebid scope. Rule of thumb: prefer 4-4 major fits, drive to game with 25+ combined HCP, slow down with minimums.' };
}

/* Opener's rebid — after responder's first response */
function recommendOpenerRebid(hand, ctx, conv) {
  const { hcp, s, h, d, c } = hand;
  const lengths = { S: s, H: h, D: d, C: c };
  const myOpen = ctx.myReal[0];
  const pResp = ctx.partnerReal[0];
  if (!myOpen || !pResp) return null;

  // Accept Jacoby Transfer: 1NT – 2D → 2H ; 1NT – 2H → 2S
  if (conv.jacobyTransfers
      && myOpen.level === 1 && myOpen.denom === 'NT'
      && pResp.level === 2 && (pResp.denom === 'D' || pResp.denom === 'H')) {
    const target = pResp.denom === 'D' ? 'H' : 'S';
    const tLen = lengths[target];
    if (hcp >= 17 && tLen >= 4) {
      return { bid: { type: 'bid', level: 3, denom: target }, explanation: `Super-accept transfer — 17 HCP and 4-card ${SYM[target]} support. Jump to 3${SYM[target]} to encourage game.` };
    }
    return { bid: { type: 'bid', level: 2, denom: target }, explanation: `Accept transfer — bid 2${SYM[target]}. Partner clarifies on the next round.` };
  }

  // Reply to Stayman: 1NT – 2C → ?
  if (myOpen.level === 1 && myOpen.denom === 'NT'
      && pResp.level === 2 && pResp.denom === 'C') {
    if (h >= 4) return { bid: { type: 'bid', level: 2, denom: 'H' }, explanation: `4-card heart suit — 2♥. (With both 4-card majors, hearts first.)` };
    if (s >= 4) return { bid: { type: 'bid', level: 2, denom: 'S' }, explanation: `4 spades, no 4-card hearts — 2♠.` };
    return { bid: { type: 'bid', level: 2, denom: 'D' }, explanation: `No 4-card major — 2♦ (denial).` };
  }

  // Reply to NMF / Checkback: 1m – 1M – 1NT – 2(other minor)
  if (conv.newMinorForcing && ctx.partnerReal.length >= 2) {
    const pFirst = ctx.partnerReal[0];
    const pSecond = ctx.partnerReal[1];
    const myFirst = ctx.myReal[0];
    const myRebid = ctx.myReal[1];
    if (myFirst && myRebid && (myFirst.denom === 'C' || myFirst.denom === 'D')
        && pFirst.level === 1 && (pFirst.denom === 'H' || pFirst.denom === 'S')
        && myRebid.level === 1 && myRebid.denom === 'NT'
        && pSecond.level === 2 && pSecond.denom !== pFirst.denom && pSecond.denom !== 'NT'
        && pSecond.denom !== myFirst.denom) {
      const respMajor = pFirst.denom;
      const otherMajor = respMajor === 'H' ? 'S' : 'H';
      const isMax = hcp >= 14;
      if (lengths[respMajor] >= 3 && isMax) return { bid: { type: 'bid', level: 3, denom: respMajor }, explanation: `Maximum (14) with 3-card ${SYM[respMajor]} — jump to 3${SYM[respMajor]}.` };
      if (lengths[respMajor] >= 3) return { bid: { type: 'bid', level: 2, denom: respMajor }, explanation: `Min (12–13) with 3-card ${SYM[respMajor]} — simple raise to 2${SYM[respMajor]}.` };
      if (lengths[otherMajor] >= 4) return { bid: { type: 'bid', level: 2, denom: otherMajor }, explanation: `No 3 ${SYM[respMajor]}, but 4 ${SYM[otherMajor]} — show 2${SYM[otherMajor]}.` };
      if (isMax) return { bid: { type: 'bid', level: 3, denom: 'NT' }, explanation: `Max no fit — 3NT.` };
      return { bid: { type: 'bid', level: 2, denom: 'NT' }, explanation: `Min no fit — 2NT.` };
    }
  }

  // 1m – 1M – ? : opener's first rebid
  if (myOpen.level === 1 && (myOpen.denom === 'C' || myOpen.denom === 'D')
      && pResp.level === 1 && (pResp.denom === 'H' || pResp.denom === 'S')) {
    const respMajor = pResp.denom;
    const supp = lengths[respMajor];
    if (supp >= 4) {
      if (hcp >= 18) return { bid: { type: 'bid', level: 4, denom: respMajor }, explanation: `4-card ${SYM[respMajor]} support, 18+ HCP — jump to game.` };
      if (hcp >= 15) return { bid: { type: 'bid', level: 3, denom: respMajor }, explanation: `4-card ${SYM[respMajor]} support, 15–17 HCP — jump raise (invitational).` };
      return { bid: { type: 'bid', level: 2, denom: respMajor }, explanation: `4-card ${SYM[respMajor]} support, 12–14 HCP — simple raise.` };
    }
    if (myOpen.denom === 'C' && pResp.denom === 'H' && s >= 4) {
      return { bid: { type: 'bid', level: 1, denom: 'S' }, explanation: `4-card spade suit — bid 1♠ up the line.` };
    }
    if (myOpen.denom === 'D' && pResp.denom === 'S' && h >= 4 && hcp >= 17) {
      return { bid: { type: 'bid', level: 2, denom: 'H' }, explanation: `Reverse 2♥ — 17+ HCP with 4 hearts and longer diamonds. Forcing one round.` };
    }
    if (isBalanced(s, h, d, c) && hcp <= 14) {
      return { bid: { type: 'bid', level: 1, denom: 'NT' }, explanation: `12–14 HCP, balanced, no support — rebid 1NT.` };
    }
    if (isBalanced(s, h, d, c) && hcp >= 18 && hcp <= 19) {
      return { bid: { type: 'bid', level: 2, denom: 'NT' }, explanation: `18–19 HCP balanced — jump to 2NT.` };
    }
    if (lengths[myOpen.denom] >= 6) {
      return { bid: { type: 'bid', level: 2, denom: myOpen.denom }, explanation: `6+ ${SYM[myOpen.denom]} — rebid 2${SYM[myOpen.denom]} showing length.` };
    }
    return { bid: { type: 'bid', level: 1, denom: 'NT' }, explanation: `Default rebid — 1NT (12–14 balanced).` };
  }

  // 1M – 2M – ? : after partner's simple raise
  if (myOpen.level === 1 && (myOpen.denom === 'H' || myOpen.denom === 'S')
      && pResp.level === 2 && pResp.denom === myOpen.denom) {
    const M = myOpen.denom;
    if (hcp >= 18) return { bid: { type: 'bid', level: 4, denom: M }, explanation: `18+ HCP — bid game 4${SYM[M]}.` };
    if (hcp >= 15) return { bid: { type: 'bid', level: 3, denom: M }, explanation: `15–17 HCP — 3${SYM[M]} game try.` };
    return { bid: { type: 'pass' }, explanation: `Min opener (12–14) opposite a single raise — pass.` };
  }

  // 1M – 3M – ? : after partner's limit raise
  if (myOpen.level === 1 && (myOpen.denom === 'H' || myOpen.denom === 'S')
      && pResp.level === 3 && pResp.denom === myOpen.denom) {
    const M = myOpen.denom;
    if (hcp >= 14) return { bid: { type: 'bid', level: 4, denom: M }, explanation: `Limit raise + 14+ HCP — bid game 4${SYM[M]}.` };
    return { bid: { type: 'pass' }, explanation: `Min opener facing limit raise — pass 3${SYM[M]}.` };
  }

  return { bid: null, explanation: 'Past the rebid engine\'s scope. With a fit, raise to the level your combined HCP supports; without one, show shape (length) or NT strength.' };
}

function getRecommendation(hand, auction, dealer, conv = DEFAULT_CONV) {
  if (hand.hcp === null || hand.s + hand.h + hand.d + hand.c !== 13) {
    return { bid: null, explanation: 'Set your hand first: HCP and four suit lengths summing to 13.' };
  }
  const ctx = analyzeAuction(auction, dealer);
  if (!ctx.isMyTurn) {
    return { bid: null, explanation: `It's ${POSITIONS[ctx.turnIdx]}'s turn next — add their bid below to continue.` };
  }

  if (ctx.firstBidder === -1) return recommendOpening(hand);

  if (ctx.firstBidder === ctx.partnerIdx) {
    if (ctx.oppActed) {
      return { bid: null, explanation: 'Competitive auction after partner opened — past the engine. Support partner with a fit, double for takeout/penalty depending on level, bid a strong 5+ suit if you have one.' };
    }
    if (ctx.myReal.length === 0) return recommendResponseToOpen(hand, ctx.firstBid, conv);
    if (ctx.partnerReal.length >= 2) return recommendResponderRebid(hand, ctx, conv);
    return { bid: null, explanation: 'Waiting for partner\'s rebid before the engine recommends.' };
  }

  if (ctx.firstBidder === ctx.myIdx) {
    if (ctx.partnerReal.length === 0) {
      return { bid: null, explanation: 'You opened. Waiting for partner to respond.' };
    }
    if (ctx.oppActed) {
      return { bid: null, explanation: 'Competitive auction after you opened — past the engine.' };
    }
    return recommendOpenerRebid(hand, ctx, conv);
  }

  if (ctx.firstBidder === ctx.rhoIdx) {
    if (ctx.myReal.length === 0) return recommendOvercall(hand, ctx.firstBid);
    return { bid: null, explanation: 'Past direct-overcall scope. After your overcall, support, raise, or compete based on shape and fit.' };
  }
  if (ctx.firstBidder === ctx.lhoIdx) {
    return { bid: null, explanation: 'LHO opened and partner passed — balancing seat. Act lightly with shape: ~9+ HCP for an overcall, ~10+ for a takeout double.' };
  }

  return { bid: null, explanation: 'Past the engine\'s scope.' };
}


/* =========================================================
   STYLES — fonts + design tokens
   ========================================================= */

const styles = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300..900&family=Sora:wght@300..700&family=JetBrains+Mono:wght@400..700&display=swap');

  .bridge-app {
    --bg:        #F2EDE0;
    --paper:     #FBF8EE;
    --paper-2:   #F6F1E1;
    --ink:       #1C1814;
    --ink-soft:  #4A4239;
    --muted:     #8A7E68;
    --line:      #D9CDB4;
    --line-soft: #E5DDC8;
    --burgundy:  #7A1F2A;
    --burgundy-soft: #B85B66;
    --felt:      #1F4D3A;
    --felt-soft: #4A8A6E;
    --gold:      #B8924D;
    --red:       #B53A2A;

    background: var(--bg);
    color: var(--ink);
    font-family: 'Sora', system-ui, sans-serif;
    min-height: 100vh;
  }
  .bridge-app .display { font-family: 'Fraunces', 'Times New Roman', serif; font-feature-settings: 'ss01'; letter-spacing: -0.01em; }
  .bridge-app .data    { font-family: 'JetBrains Mono', monospace; font-variant-numeric: tabular-nums; }

  .bridge-app * { -webkit-tap-highlight-color: transparent; }
  .bridge-app button { touch-action: manipulation; }

  .bridge-app *::-webkit-scrollbar { width: 8px; height: 8px; }
  .bridge-app *::-webkit-scrollbar-track { background: transparent; }
  .bridge-app *::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }

  .bridge-app .grain {
    background-image:
      radial-gradient(circle at 20% 30%, rgba(184,146,77,0.05) 0%, transparent 40%),
      radial-gradient(circle at 80% 70%, rgba(31,77,58,0.04) 0%, transparent 50%);
  }

  .bridge-app .card-tile {
    background: var(--paper);
    border: 1px solid var(--line);
    transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
  }

  .bridge-app .pill-btn {
    border: 1px solid var(--line);
    background: var(--paper);
    transition: all 100ms ease;
  }
  .bridge-app .pill-btn.active { background: var(--ink); color: var(--paper); border-color: var(--ink); }

  .bridge-app .chip-btn { border: 1px solid var(--line); background: var(--paper); transition: background 100ms ease; }
  .bridge-app .chip-btn:disabled { opacity: 0.35; cursor: not-allowed; }

  /* Tactile feedback on tap (works on both touch and mouse) */
  .bridge-app .pill-btn:active:not(.active) { background: var(--paper-2); border-color: var(--ink-soft); }
  .bridge-app .chip-btn:active:not(:disabled) { background: var(--paper-2); }
  .bridge-app .card-tile:active { border-color: var(--ink-soft); }

  /* Hover effects only where actual hover is supported (i.e. mouse, not touch) */
  @media (hover: hover) {
    .bridge-app .card-tile:hover { transform: translateY(-1px); border-color: var(--ink-soft); }
    .bridge-app .pill-btn:hover { border-color: var(--ink); background: var(--paper-2); }
    .bridge-app .chip-btn:hover:not(:disabled) { background: var(--paper-2); }
  }

  .bridge-app .red-suit  { color: var(--red); }
  .bridge-app .blk-suit  { color: var(--ink); }

  .bridge-app .recommendation {
    background: linear-gradient(180deg, var(--paper) 0%, var(--paper-2) 100%);
    border: 1px solid var(--line);
    border-left: 4px solid var(--burgundy);
  }
`;

/* =========================================================
   COMPONENTS
   ========================================================= */

function PointsCounter() {
  const HONORS = ['A', 'K', 'Q', 'J'];
  const SUITS_DISPLAY = ['♠', '♥', '♦', '♣'];
  const SUIT_TO_KEY = { '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' };
  const HCP_VALUE = { A: 4, K: 3, Q: 2, J: 1 };

  const initialHonors = {};
  for (const r of HONORS) for (const s of SUITS_DISPLAY) initialHonors[`${r}${s}`] = null;

  const [honors, setHonors] = useState(initialHonors);
  const [suitLengths, setSuitLengths] = useState({
    N: { S: '', H: '', D: '', C: '' },
    E: { S: '', H: '', D: '', C: '' },
    S: { S: '', H: '', D: '', C: '' },
    W: { S: '', H: '', D: '', C: '' },
  });
  const [notes, setNotes] = useState('');

  const cycleOwner = (key) => {
    const order = [null, 'S', 'N', 'E', 'W'];
    const idx = order.indexOf(honors[key]);
    setHonors({ ...honors, [key]: order[(idx + 1) % order.length] });
  };

  const totals = useMemo(() => {
    const t = { N: 0, E: 0, S: 0, W: 0, unassigned: 0 };
    for (const k in honors) {
      const rank = k[0];
      const v = HCP_VALUE[rank];
      const owner = honors[k];
      if (owner) t[owner] += v;
      else t.unassigned += v;
    }
    return t;
  }, [honors]);

  const setLen = (pos, suit, val) => {
    const cleaned = val === '' ? '' : Math.max(0, Math.min(13, parseInt(val) || 0));
    setSuitLengths({ ...suitLengths, [pos]: { ...suitLengths[pos], [suit]: cleaned } });
  };

  const reset = () => {
    setHonors(initialHonors);
    setSuitLengths({
      N: { S: '', H: '', D: '', C: '' },
      E: { S: '', H: '', D: '', C: '' },
      S: { S: '', H: '', D: '', C: '' },
      W: { S: '', H: '', D: '', C: '' },
    });
    setNotes('');
  };

  return (
    <div className="space-y-6">
      {/* Header summary */}
      <div className="recommendation rounded-lg p-4 sm:p-5">
        <div className="flex items-baseline justify-between gap-4 flex-wrap">
          <div>
            <div className="text-xs uppercase tracking-[0.2em]" style={{ color: 'var(--muted)' }}>HCP accounting</div>
            <div className="display text-2xl sm:text-3xl mt-1">
              <span className="data">{40 - totals.unassigned}</span>
              <span style={{ color: 'var(--muted)' }}> / 40 placed</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-[0.2em]" style={{ color: 'var(--muted)' }}>Unaccounted</div>
            <div className="display text-2xl sm:text-3xl mt-1 data" style={{ color: 'var(--burgundy)' }}>{totals.unassigned}</div>
          </div>
        </div>
      </div>

      {/* Position panels */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {POSITIONS.map((pos) => (
          <div key={pos} className="card-tile rounded-lg p-3" style={{ borderColor: PlayerColors[pos].bg, borderWidth: 1 }}>
            <div className="flex items-center justify-between">
              <div className="display text-lg" style={{ color: PlayerColors[pos].bg }}>{pos}</div>
              <div className="data text-xl">{totals[pos]}</div>
            </div>
            <div className="text-[10px] uppercase tracking-wider mt-0.5" style={{ color: 'var(--muted)' }}>HCP placed</div>
          </div>
        ))}
      </div>

      {/* Honor grid */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="display text-xl">Honors</h3>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>Tap to cycle: — → S → N → E → W</div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {HONORS.map((rank) =>
            SUITS_DISPLAY.map((suit) => {
              const key = `${rank}${suit}`;
              return <HonorTile key={key} rank={rank} suit={suit} owner={honors[key]} onClick={() => cycleOwner(key)} />;
            })
          )}
        </div>
      </div>

      {/* Suit length tracker */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="display text-xl">Suit lengths</h3>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>Each column should sum to 13</div>
        </div>
        <div className="card-tile rounded-lg p-3 overflow-x-auto">
          <table className="w-full data text-sm">
            <thead>
              <tr style={{ color: 'var(--muted)' }}>
                <th className="text-left p-2 font-normal text-xs uppercase tracking-wider">Pos</th>
                {SUITS_DISPLAY.map((s) => (
                  <th key={s} className={`p-2 font-normal text-base ${s === '♥' || s === '♦' ? 'red-suit' : 'blk-suit'}`}>{s}</th>
                ))}
                <th className="p-2 font-normal text-xs uppercase tracking-wider">Σ</th>
              </tr>
            </thead>
            <tbody>
              {POSITIONS.map((pos) => {
                const row = suitLengths[pos];
                const sum = SUITS_DISPLAY.reduce((acc, s) => acc + (parseInt(row[SUIT_TO_KEY[s]]) || 0), 0);
                return (
                  <tr key={pos} style={{ borderTop: '1px solid var(--line-soft)' }}>
                    <td className="p-2 display text-base" style={{ color: PlayerColors[pos].bg }}>{pos}</td>
                    {SUITS_DISPLAY.map((s) => (
                      <td key={s} className="p-1">
                        <input
                          type="text"
                          inputMode="numeric"
                          value={row[SUIT_TO_KEY[s]]}
                          onChange={(e) => setLen(pos, SUIT_TO_KEY[s], e.target.value)}
                          className="w-12 text-center rounded border bg-transparent py-2 outline-none"
                          style={{ borderColor: 'var(--line)' }}
                          placeholder="–"
                        />
                      </td>
                    ))}
                    <td className="p-2" style={{ color: sum === 13 ? 'var(--felt)' : sum > 13 ? 'var(--burgundy)' : 'var(--muted)' }}>{sum || ''}</td>
                  </tr>
                );
              })}
              <tr style={{ borderTop: '1px solid var(--line)' }}>
                <td className="p-2 text-xs uppercase tracking-wider" style={{ color: 'var(--muted)' }}>Σ</td>
                {SUITS_DISPLAY.map((s) => {
                  const total = POSITIONS.reduce((acc, p) => acc + (parseInt(suitLengths[p][SUIT_TO_KEY[s]]) || 0), 0);
                  return (
                    <td key={s} className="p-2" style={{ color: total === 13 ? 'var(--felt)' : total > 13 ? 'var(--burgundy)' : 'var(--muted)' }}>
                      {total || ''}
                    </td>
                  );
                })}
                <td className="p-2" style={{ color: 'var(--muted)' }}>52</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Notes */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="display text-xl">Inferences from bidding</h3>
        </div>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="e.g. W opened 1NT → 15-17 HCP; E raised to 3NT → 10+ HCP balanced…"
          className="w-full card-tile rounded-lg p-3 text-sm bg-transparent outline-none resize-y"
          style={{ minHeight: 80 }}
        />
      </div>

      {/* Reset */}
      <div className="flex justify-end">
        <button
          onClick={reset}
          className="pill-btn rounded-full px-4 py-2 text-sm flex items-center gap-2"
        >
          <RotateCcw size={14} /> Reset all
        </button>
      </div>
    </div>
  );
}

function HandInput({ hand, setHand }) {
  const setVal = (k, v) => {
    const clean = v === '' ? '' : Math.max(0, Math.min(40, parseInt(v) || 0));
    setHand({ ...hand, [k]: clean === '' ? null : clean });
  };
  const setLen = (k, v) => {
    const clean = v === '' ? 0 : Math.max(0, Math.min(13, parseInt(v) || 0));
    setHand({ ...hand, [k]: clean });
  };
  const total = (hand.s || 0) + (hand.h || 0) + (hand.d || 0) + (hand.c || 0);
  const valid = total === 13 && hand.hcp !== null && hand.hcp !== '';

  return (
    <div className="card-tile rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="display text-xl">Your hand</h3>
        <div className="text-xs data" style={{ color: total === 13 ? 'var(--felt)' : 'var(--burgundy)' }}>
          {total}/13 cards
        </div>
      </div>
      <div className="grid grid-cols-5 gap-2 sm:gap-3">
        <div>
          <label className="text-[10px] uppercase tracking-wider block mb-1" style={{ color: 'var(--muted)' }}>HCP</label>
          <input
            type="text"
            inputMode="numeric"
            value={hand.hcp ?? ''}
            onChange={(e) => setVal('hcp', e.target.value)}
            className="w-full text-center rounded border py-2 px-2 data text-lg bg-transparent outline-none"
            style={{ borderColor: 'var(--line)' }}
          />
        </div>
        {[
          { k: 's', label: '♠', red: false },
          { k: 'h', label: '♥', red: true },
          { k: 'd', label: '♦', red: true },
          { k: 'c', label: '♣', red: false },
        ].map(({ k, label, red }) => (
          <div key={k}>
            <label className={`text-base block mb-1 text-center ${red ? 'red-suit' : 'blk-suit'}`}>{label}</label>
            <input
              type="text"
              inputMode="numeric"
              value={hand[k]}
              onChange={(e) => setLen(k, e.target.value)}
              className="w-full text-center rounded border py-2 px-2 data text-lg bg-transparent outline-none"
              style={{ borderColor: 'var(--line)' }}
            />
          </div>
        ))}
      </div>
      {!valid && (
        <div className="mt-2 text-xs" style={{ color: 'var(--burgundy)' }}>
          Set HCP and four suit lengths summing to 13.
        </div>
      )}
    </div>
  );
}


function ConventionsPanel({ conv, setConv }) {
  return (
    <Collapsible title="Conventions" icon={<Settings2 size={14} />} defaultOpen={false}>
      <div className="space-y-2 mt-2">
        <Toggle
          checked={conv.jacobyTransfers}
          onChange={(v) => setConv({ ...conv, jacobyTransfers: v })}
          label="Jacoby Transfers (over 1NT)"
        />
        <Toggle
          checked={conv.newMinorForcing}
          onChange={(v) => setConv({ ...conv, newMinorForcing: v })}
          label="New Minor Forcing / Checkback Stayman"
        />
        <div className="text-xs leading-relaxed mt-3" style={{ color: 'var(--muted)' }}>
          The engine adapts its 1NT response logic and the responder's rebid sequence to whichever conventions are on. Other conventions (Jacoby 2NT, Negative doubles, Lebensohl, Michaels, RKCB) aren't engine-aware in this build.
        </div>
      </div>
    </Collapsible>
  );
}

function BidAdvisor({ auction, setAuction, dealer, setDealer }) {
  const [hand, setHand] = useState({ hcp: null, s: 0, h: 0, d: 0, c: 0 });
  const [vul, setVul] = useState('None');
  const [showLogic, setShowLogic] = useState(true);
  const [conv, setConv] = useState(DEFAULT_CONV);

  const addBid = (b) => setAuction([...auction, b]);
  const undoBid = () => setAuction(auction.slice(0, -1));
  const resetAuction = () => setAuction([]);

  const recommendation = useMemo(() => getRecommendation(hand, auction, dealer, conv), [hand, auction, dealer, conv]);

  return (
    <div className="space-y-6">
      {/* Setup row */}
      <div className="card-tile rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="display text-xl">Table</h3>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>You sit South</div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--muted)' }}>Dealer</div>
            <div className="flex gap-1">
              {POSITIONS.map((p) => (
                <button
                  key={p}
                  onClick={() => { setDealer(p); setAuction([]); }}
                  className={`pill-btn rounded-md flex-1 py-2 display text-base ${dealer === p ? 'active' : ''}`}
                >{p}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--muted)' }}>Vulnerability</div>
            <div className="flex gap-1">
              {['None', 'NS', 'EW', 'Both'].map((v) => (
                <button
                  key={v}
                  onClick={() => setVul(v)}
                  className={`pill-btn rounded-md flex-1 py-2 text-sm ${vul === v ? 'active' : ''}`}
                >{v}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <HandInput hand={hand} setHand={setHand} />

      <ConventionsPanel conv={conv} setConv={setConv} />

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="display text-xl">Auction</h3>
          {auction.length > 0 && (
            <button onClick={resetAuction} className="text-xs flex items-center gap-1" style={{ color: 'var(--muted)' }}>
              <RotateCcw size={12} /> Clear
            </button>
          )}
        </div>
        <AuctionDisplay auction={auction} dealer={dealer} onUndo={undoBid} />
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="display text-xl">Enter the next bid</h3>
        </div>
        <BidKeypad auction={auction} addBid={addBid} />
      </div>

      {/* Recommendation */}
      <div className="recommendation rounded-lg p-4 sm:p-5">
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <div className="text-xs uppercase tracking-[0.2em]" style={{ color: 'var(--burgundy)' }}>Engine recommends</div>
          <button
            onClick={() => setShowLogic(!showLogic)}
            className="text-xs flex items-center gap-1"
            style={{ color: 'var(--muted)' }}
          >
            {showLogic ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {showLogic ? 'Hide' : 'Show'} reasoning
          </button>
        </div>
        <div className="display text-3xl sm:text-4xl mb-2">
          {recommendation.bid ? (
            <span>
              {recommendation.bid.type === 'pass' && 'Pass'}
              {recommendation.bid.type === 'dbl' && <span style={{ color: 'var(--burgundy)' }}>Double</span>}
              {recommendation.bid.type === 'rdbl' && <span style={{ color: 'var(--felt)' }}>Redouble</span>}
              {recommendation.bid.type === 'bid' && (
                <>
                  <span className="data">{recommendation.bid.level}</span>
                  <span className={recommendation.bid.denom === 'H' || recommendation.bid.denom === 'D' ? 'red-suit' : 'blk-suit'}>{SYM[recommendation.bid.denom]}</span>
                </>
              )}
            </span>
          ) : (
            <span style={{ color: 'var(--muted)' }} className="text-xl sm:text-2xl">— waiting on input —</span>
          )}
          {recommendation.bid && (
            <button
              onClick={() => addBid(recommendation.bid)}
              className="ml-3 align-middle pill-btn rounded-full px-3 py-1 text-xs"
            >Apply this bid</button>
          )}
        </div>
        {showLogic && (
          <div className="text-sm leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
            {recommendation.explanation}
          </div>
        )}
      </div>

      <div className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
        <Info size={12} className="inline -mt-0.5 mr-1" />
        The engine covers SAYC opening bids, responses to partner's opening, and direct overcalls/takeout doubles. Highly competitive auctions, slam exploration, and rebids in long sequences fall back to general principles.
      </div>
    </div>
  );
}

/* =========================================================
   CARD-PLAY HELPERS — heuristic, not a card-play AI
   ========================================================= */

function LeadHelper({ auction, setAuction, dealer, setDealer }) {
  const [contract, setContract] = useState({ level: 3, denom: 'NT' });
  const [holdingsRaw, setHoldingsRaw] = useState({ S: '', H: '', D: '', C: '' });

  const suits = useMemo(() => ({
    S: parseHolding(holdingsRaw.S),
    H: parseHolding(holdingsRaw.H),
    D: parseHolding(holdingsRaw.D),
    C: parseHolding(holdingsRaw.C),
  }), [holdingsRaw]);

  const totalCards = suits.S.length + suits.H.length + suits.D.length + suits.C.length;

  // Auction-derived contract (when 3-pass-out) takes priority over the manual picker.
  const auctionContract = useMemo(() => deriveContract(auction), [auction]);
  const effectiveContract = auctionContract || contract;

  const result = useMemo(() => {
    if (totalCards === 0) return null;
    return recommendOpeningLead({ contract: effectiveContract, suits, auction, dealer });
  }, [effectiveContract, suits, auction, dealer, totalCards]);

  const addBid = (b) => setAuction([...auction, b]);
  const undoBid = () => setAuction(auction.slice(0, -1));
  const resetAuction = () => setAuction([]);

  const reset = () => {
    setHoldingsRaw({ S: '', H: '', D: '', C: '' });
  };

  const leaderSeat = result?.leadContext?.leaderSeat;
  const leaderBanner = leaderSeat && leaderSeat !== 'S';

  return (
    <div className="space-y-5">
      <div className="card-tile rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="display text-xl">Final contract</h3>
          <div className="text-xs data" style={{ color: 'var(--muted)' }}>
            <span style={{ color: 'var(--ink)' }}>{effectiveContract.level}</span>
            <span className={effectiveContract.denom === 'H' || effectiveContract.denom === 'D' ? 'red-suit' : 'blk-suit'} style={{ marginLeft: 2 }}>{SYM[effectiveContract.denom]}</span>
            {auctionContract && <span style={{ marginLeft: 8, color: 'var(--felt)' }}>· auto from auction</span>}
          </div>
        </div>
        <ContractPicker contract={contract} setContract={setContract} />
        {auctionContract && (
          <div className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            Contract is being read from the auction below. The picker above acts as a fallback when no auction is entered.
          </div>
        )}
      </div>

      <div className="card-tile rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="display text-xl">Your hand</h3>
          <div className="text-xs data" style={{ color: totalCards === 13 ? 'var(--felt)' : 'var(--burgundy)' }}>
            {totalCards}/13 cards
          </div>
        </div>
        <div className="space-y-2">
          {['S', 'H', 'D', 'C'].map((d) => (
            <SuitInput key={d} suit={d} value={holdingsRaw[d]} onChange={(v) => setHoldingsRaw({ ...holdingsRaw, [d]: v })} />
          ))}
        </div>
        <div className="mt-2 text-[11px] leading-relaxed" style={{ color: 'var(--muted)' }}>
          Use 10 or T for ten. Order doesn't matter — engine sorts. Leave a suit blank if void.
        </div>
      </div>

      <div className="card-tile rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="display text-xl">Auction</h3>
          {auction.length > 0 && (
            <button onClick={resetAuction} className="text-xs flex items-center gap-1" style={{ color: 'var(--muted)' }}>
              <RotateCcw size={12} /> Clear
            </button>
          )}
        </div>
        <div className="text-[11px] leading-relaxed mb-3" style={{ color: 'var(--muted)' }}>
          Shared with the Auction Advisor tab — entering the bidding here sharpens the lead recommendation (unbid suits, takeout doubles, partner pass-throughs).
        </div>
        <div className="mb-3">
          <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--muted)' }}>Dealer</div>
          <div className="flex gap-1">
            {POSITIONS.map((p) => (
              <button
                key={p}
                onClick={() => { setDealer(p); setAuction([]); }}
                className={`pill-btn rounded-md flex-1 py-2 display text-base ${dealer === p ? 'active' : ''}`}
              >{p}</button>
            ))}
          </div>
        </div>
        <AuctionDisplay auction={auction} dealer={dealer} onUndo={undoBid} />
        <div className="mt-3">
          <BidKeypad auction={auction} addBid={addBid} />
        </div>
      </div>

      {leaderBanner && (
        <div className="rounded-lg p-3 text-xs leading-relaxed" style={{ background: 'var(--paper-2)', border: '1px solid var(--line)', color: 'var(--ink-soft)' }}>
          <Info size={12} className="inline -mt-0.5 mr-1" />
          In this auction <span className="display" style={{ color: 'var(--ink)' }}>{leaderSeat}</span> is on lead. The recommendation below is what you'd lead from this hand — useful for thinking along.
        </div>
      )}

      {result && result.primary && (
        <div className="recommendation rounded-lg p-4 sm:p-5">
          {result.contextSummary && result.contextSummary.length > 0 && (
            <div className="mb-3 pb-3" style={{ borderBottom: '1px solid var(--line-soft)' }}>
              <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--muted)' }}>Auction context</div>
              <ul className="text-xs leading-relaxed space-y-0.5" style={{ color: 'var(--ink-soft)' }}>
                {result.contextSummary.map((s, i) => <li key={i}>· {s}</li>)}
              </ul>
            </div>
          )}
          <div className="text-xs uppercase tracking-[0.2em] mb-2" style={{ color: 'var(--burgundy)' }}>Suggested lead</div>
          <div className="display text-3xl sm:text-4xl mb-2">
            <span className="data">{result.primary.lead === 'T' ? '10' : result.primary.lead}</span>
            <span className={result.primary.suit === 'H' || result.primary.suit === 'D' ? 'red-suit' : 'blk-suit'} style={{ marginLeft: 4 }}>
              {SYM[result.primary.suit]}
            </span>
            <span className="text-sm ml-3 data" style={{ color: 'var(--muted)' }}>
              from {result.primary.holding.map((r) => r === 'T' ? '10' : r).join('')}
            </span>
          </div>
          <ul className="text-sm leading-relaxed space-y-1 mt-2" style={{ color: 'var(--ink-soft)' }}>
            {result.primary.reasons.map((r, i) => (
              <li key={i}>· {r}</li>
            ))}
          </ul>

          {result.alternatives.filter((a) => a.score > -15).length > 0 && (
            <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--line-soft)' }}>
              <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted)' }}>Alternatives</div>
              <div className="space-y-1.5">
                {result.alternatives.filter((a) => a.score > -15).slice(0, 3).map((alt, i) => (
                  <div key={i} className="text-xs flex items-baseline gap-2" style={{ color: 'var(--ink-soft)' }}>
                    <span className="data">
                      {alt.lead === 'T' ? '10' : alt.lead}
                      <span className={alt.suit === 'H' || alt.suit === 'D' ? 'red-suit' : 'blk-suit'}>{SYM[alt.suit]}</span>
                    </span>
                    <span className="flex-1">{alt.reasons[0]}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {totalCards > 0 && (
        <div className="flex justify-end">
          <button onClick={reset} className="pill-btn rounded-full px-4 py-2 text-sm flex items-center gap-2">
            <RotateCcw size={14} /> Reset hand
          </button>
        </div>
      )}

      <div className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
        <Info size={12} className="inline -mt-0.5 mr-1" />
        Heuristic — applies SAYC opening-lead rules plus auction-context inference (trump-promotion risk, doubleton-honor traps, unbid suits, takeout doubles, partner pass-throughs). It does not run a double-dummy search; on tricky layouts a real bridge AI may disagree.
      </div>
    </div>
  );
}

function SignalsReference() {
  return (
    <div className="space-y-3 text-sm" style={{ color: 'var(--ink-soft)' }}>
      <div>
        <div className="display text-base mb-1" style={{ color: 'var(--ink)' }}>Attitude (standard)</div>
        <p>High card encourages partner's suit, low card discourages. Played on partner's lead when you can't win the trick.</p>
      </div>
      <div>
        <div className="display text-base mb-1" style={{ color: 'var(--ink)' }}>Count (standard)</div>
        <p>High-low shows an even number of cards in the suit; low-high shows an odd number. Played mainly on declarer's lead.</p>
      </div>
      <div>
        <div className="display text-base mb-1" style={{ color: 'var(--ink)' }}>Suit-preference (Lavinthal)</div>
        <p>When neither attitude nor count is the priority — e.g. when giving partner a ruff or cashing the setting trick — a high card asks for the higher of the remaining two suits, a low card asks for the lower.</p>
      </div>
      <div>
        <div className="display text-base mb-1" style={{ color: 'var(--ink)' }}>Discards</div>
        <p>First discard is typically attitude (high = like that suit). Some pairs play odd-even or upside-down — partnership agreement.</p>
      </div>
    </div>
  );
}

function DefensiveMaxims() {
  const maxims = [
    ['Second hand low', 'Don\'t spend an honor when there\'s no card to capture. Force declarer to guess.'],
    ['Third hand high', 'When partner leads low and dummy plays low, play your highest needed card to push out a stopper.'],
    ['Cover an honor with an honor', 'Especially when there\'s a chance to promote your own (or partner\'s) intermediate card. Don\'t cover the first of touching honors.'],
    ['Count declarer\'s tricks', 'In NT, defenders need to set up enough tricks before declarer does. Knowing declarer\'s trick count tells you when to attack and when to wait.'],
    ['Lead through strength, up to weakness', 'When in doubt about which suit to lead through dummy: lead through dummy\'s strength toward partner, lead toward dummy\'s weakness.'],
    ['Don\'t lead a new suit unnecessarily', 'After the opening lead, switching suits often helps declarer. If your suit is alive and partner has signalled, keep going.'],
    ['Eight ever, nine never', 'When missing the queen with 9 trumps between you and dummy, play for the drop; with 8, take the finesse.'],
  ];
  return (
    <ul className="space-y-2 text-sm" style={{ color: 'var(--ink-soft)' }}>
      {maxims.map(([title, body]) => (
        <li key={title}>
          <span className="display" style={{ color: 'var(--ink)' }}>{title}.</span> <span>{body}</span>
        </li>
      ))}
    </ul>
  );
}

function DeclarerPlan() {
  const steps = [
    ['Count winners (in NT) or losers (in suit)', 'In a NT contract, count immediate top tricks. In a suit contract, count losers from declarer\'s perspective.'],
    ['Identify the gap', 'How many extra tricks do you need to make the contract? That\'s the work the rest of your plan has to do.'],
    ['Pick the source of extra tricks', 'Length, finesse, ruffing, throw-in, squeeze. Most contracts are made by establishing a long suit or taking a finesse.'],
    ['Watch the entries', 'Where will you be when you need to be in dummy? Don\'t strand a long suit in dummy with no entry to it.'],
    ['Plan the trump suit', 'In suit contracts, decide trump timing — draw trumps now, or wait so you can ruff losers in dummy first?'],
    ['Play card 1 with the plan in mind', 'Once you\'ve decided, the play almost always picks itself. Don\'t play to the first trick on autopilot.'],
  ];
  return (
    <ol className="space-y-2 text-sm list-decimal pl-5" style={{ color: 'var(--ink-soft)' }}>
      {steps.map(([title, body]) => (
        <li key={title}>
          <span className="display" style={{ color: 'var(--ink)' }}>{title}.</span> <span>{body}</span>
        </li>
      ))}
    </ol>
  );
}

function CardPlayTab({ auction, setAuction, dealer, setDealer }) {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="display text-2xl mb-1">Opening lead helper</h2>
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          Enter the contract, your hand, and the auction. The engine ranks the four suits using SAYC lead rules and the auction context.
        </div>
      </div>
      <LeadHelper auction={auction} setAuction={setAuction} dealer={dealer} setDealer={setDealer} />

      <div className="pt-2">
        <h2 className="display text-2xl mb-3">Reference</h2>
        <div className="space-y-2">
          <Collapsible title="Defensive signals" icon={<Info size={14} />}>
            <SignalsReference />
          </Collapsible>
          <Collapsible title="Defensive maxims" icon={<Info size={14} />}>
            <DefensiveMaxims />
          </Collapsible>
          <Collapsible title="Declarer's plan (6 steps)" icon={<Info size={14} />}>
            <DeclarerPlan />
          </Collapsible>
        </div>
      </div>

      <div className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
        <Info size={12} className="inline -mt-0.5 mr-1" />
        These are heuristic helpers, not a card-play engine. For an actual "next card to play" AI, Funbridge's own Argine is your best bet — it runs double-dummy + Monte Carlo at every decision.
      </div>
    </div>
  );
}

/* =========================================================
   ROOT
   ========================================================= */

export default function BridgeTool() {
  const [tab, setTab] = useState('counter');
  // Auction + dealer are lifted to root so the Auction Advisor and Card Play
  // tabs share a single source of truth — switching tabs preserves the auction.
  const [auction, setAuction] = useState([]);
  const [dealer, setDealer] = useState('N');

  return (
    <div className="bridge-app">
      <style>{styles}</style>
      <div className="grain min-h-screen">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 sm:py-10">
          {/* Masthead */}
          <header className="mb-6 sm:mb-8 flex items-end justify-between flex-wrap gap-2">
            <div>
              <div className="text-[11px] uppercase tracking-[0.3em] mb-1" style={{ color: 'var(--burgundy)' }}>
                Bridge Companion · SAYC
              </div>
              <h1 className="display text-4xl sm:text-5xl leading-none">
                The <span style={{ fontStyle: 'italic', color: 'var(--burgundy)' }}>Defender's</span> Eye
              </h1>
              <div className="display italic text-sm mt-1" style={{ color: 'var(--muted)' }}>
                count the cards · trust the auction
              </div>
            </div>
          </header>

          {/* Tab switcher */}
          <div className="flex gap-1 mb-6 p-1 rounded-lg card-tile" style={{ width: 'fit-content' }}>
            <button
              onClick={() => setTab('counter')}
              className={`px-4 py-2 rounded-md text-sm transition ${tab === 'counter' ? 'active' : ''}`}
              style={tab === 'counter' ? { background: 'var(--ink)', color: 'var(--paper)' } : { color: 'var(--ink-soft)' }}
            >
              Card Counter
            </button>
            <button
              onClick={() => setTab('bidder')}
              className={`px-4 py-2 rounded-md text-sm transition ${tab === 'bidder' ? 'active' : ''}`}
              style={tab === 'bidder' ? { background: 'var(--ink)', color: 'var(--paper)' } : { color: 'var(--ink-soft)' }}
            >
              Auction Advisor
            </button>
            <button
              onClick={() => setTab('play')}
              className={`px-4 py-2 rounded-md text-sm transition ${tab === 'play' ? 'active' : ''}`}
              style={tab === 'play' ? { background: 'var(--ink)', color: 'var(--paper)' } : { color: 'var(--ink-soft)' }}
            >
              Card Play
            </button>
            <button
              onClick={() => setTab('live')}
              className={`px-4 py-2 rounded-md text-sm transition ${tab === 'live' ? 'active' : ''}`}
              style={tab === 'live' ? { background: 'var(--ink)', color: 'var(--paper)' } : { color: 'var(--ink-soft)' }}
            >
              Live Play
            </button>
          </div>

          {tab === 'counter' && <PointsCounter />}
          {tab === 'bidder' && <BidAdvisor auction={auction} setAuction={setAuction} dealer={dealer} setDealer={setDealer} />}
          {tab === 'play' && <CardPlayTab auction={auction} setAuction={setAuction} dealer={dealer} setDealer={setDealer} />}
          {tab === 'live' && <LivePlayTab auction={auction} dealer={dealer} />}

          <footer className="mt-12 pt-6 text-xs" style={{ borderTop: '1px solid var(--line-soft)', color: 'var(--muted)' }}>
            <div className="flex justify-between flex-wrap gap-2">
              <span>Standard American Yellow Card · v2.4 · Mobile PWA</span>
              <span className="display italic">play your cards close</span>
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}
