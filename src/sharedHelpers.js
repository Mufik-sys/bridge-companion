/* Shared constants + pure-function utilities used across BridgeTool.jsx,
   uiComponents.jsx, LivePlayTab.jsx, and the engine modules.

   Kept deliberately minimal — only things that are clearly cross-cutting.
   The bidding engine (recommendOpening, recommendResponseToOpen, ...) and
   the lead engine (recommendOpeningLead, deriveLeadContext, ...) stay in
   BridgeTool.jsx; pulling them out is deferred future work. */

export const DENOMS = ['C', 'D', 'H', 'S', 'NT'];
export const SYM = { C: '♣', D: '♦', H: '♥', S: '♠', NT: 'NT' };
export const SUIT_LIST = ['S', 'H', 'D', 'C'];
export const POSITIONS = ['N', 'E', 'S', 'W']; // clockwise
export const POS_INDEX = { N: 0, E: 1, S: 2, W: 3 };

export const RANK_VAL = { A: 14, K: 13, Q: 12, J: 11, T: 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2 };
export const NORM_RANK = { 'A': 'A', 'K': 'K', 'Q': 'Q', 'J': 'J', 'T': 'T', '10': 'T', '9': '9', '8': '8', '7': '7', '6': '6', '5': '5', '4': '4', '3': '3', '2': '2' };

export const RANKS_DESC = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
export const HONORS_HCP = { A: 4, K: 3, Q: 2, J: 1 };

export const PlayerColors = {
  N: { bg: '#1C1814', fg: '#FBF8EE', label: 'N' },
  E: { bg: '#7A1F2A', fg: '#FBF8EE', label: 'E' },
  S: { bg: '#1F4D3A', fg: '#FBF8EE', label: 'S' },
  W: { bg: '#B8924D', fg: '#1C1814', label: 'W' },
};

/* ---- Bid helpers ---- */
export const bidValue = (b) => (b.type !== 'bid' ? -1 : b.level * 5 + DENOMS.indexOf(b.denom));

export const lastSuitBid = (auction) => {
  for (let i = auction.length - 1; i >= 0; i--) if (auction[i].type === 'bid') return auction[i];
  return null;
};

export const isLegalBid = (bid, auction) => {
  if (bid.type === 'pass') return true;
  if (bid.type === 'bid') {
    const last = lastSuitBid(auction);
    return !last || bidValue(bid) > bidValue(last);
  }
  if (bid.type === 'dbl') {
    for (let i = auction.length - 1; i >= 0; i--) {
      if (auction[i].type === 'bid') return true;
      if (auction[i].type === 'dbl' || auction[i].type === 'rdbl') return false;
    }
    return false;
  }
  if (bid.type === 'rdbl') {
    for (let i = auction.length - 1; i >= 0; i--) {
      if (auction[i].type === 'dbl') return true;
      if (auction[i].type === 'bid' || auction[i].type === 'rdbl') return false;
    }
    return false;
  }
  return false;
};

export const bidLabel = (b) => {
  if (!b) return '';
  if (b.type === 'pass') return 'Pass';
  if (b.type === 'dbl') return 'X';
  if (b.type === 'rdbl') return 'XX';
  return `${b.level}${SYM[b.denom]}`;
};

/* ---- Holding parsing & shape detection ---- */
export function parseHolding(str) {
  if (!str) return [];
  const s = str.toUpperCase().replace(/\s/g, '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (i + 1 < s.length && s[i] === '1' && s[i + 1] === '0') { out.push('T'); i += 2; continue; }
    const ch = s[i];
    if (NORM_RANK[ch]) out.push(NORM_RANK[ch]);
    i += 1;
  }
  out.sort((a, b) => RANK_VAL[b] - RANK_VAL[a]);
  return out;
}

export function isSeq(holding, n) {
  if (holding.length < n) return false;
  for (let i = 0; i < n - 1; i++) {
    if (RANK_VAL[holding[i]] - RANK_VAL[holding[i + 1]] !== 1) return false;
  }
  return true;
}

export function hasInternalSeq(h) {
  if (h.length < 4) return null;
  const top = h[0];
  const seq = h.slice(1, 4);
  if (RANK_VAL[top] - RANK_VAL[seq[0]] >= 2 && isSeq(seq, 3)) {
    return { topHonor: top, seqStart: seq[0] };
  }
  return null;
}

/* ---- HCP counting on a list of {suit, rank} cards ---- */
export function handHCP(cards) {
  let h = 0;
  for (const c of cards) if (HONORS_HCP[c.rank]) h += HONORS_HCP[c.rank];
  return h;
}

/* ---- Card serialization for stable storage ---- */
export const cardId = (c) => `${c.rank}${c.suit}`; // e.g. "KS"
export const cardFromId = (id) => ({ rank: id[0], suit: id[1] });

/* ---- Auction-context helpers ----
   These derive the final contract and the leader's view of the auction.
   Used by both the lead engine (in BridgeTool.jsx) and the inference engine
   (in engines/inference.js), so they live here to keep imports acyclic.
   The actual lead-engine scoring (recommendOpeningLead, analyzeSuit,
   LEAD_WEIGHTS) stays in BridgeTool.jsx — that refactor is deferred. */

/* Derive the final contract from a complete auction (last bid before 3 trailing passes).
   Returns null for in-progress, passed-out, or empty auctions. */
export function deriveContract(auction) {
  if (auction.length < 4) return null;
  if (!auction.slice(-3).every((b) => b.type === 'pass')) return null;
  for (let i = auction.length - 4; i >= 0; i--) {
    if (auction[i].type === 'bid') return { level: auction[i].level, denom: auction[i].denom };
  }
  return null; // passed out
}

/* Build a rich auction context for the opening-lead engine. Parametric over
   which seat is on lead (derived from contract); otherwise falls back to South.

   Returns:
     { contract, declarer, dummy, leaderSeat, partnerSeat, dealer,
       bidsBySeat, declarerSuits, partnerSuits, leaderSuits, unbidSuits,
       doubles: { byDefenderSide, byDeclarerSide },
       partnerPassedThroughout, leaderPassedThroughout,
       summary: string[] } */
export function deriveLeadContext(auction, dealer, contract) {
  const dealerIdx = POS_INDEX[dealer];
  const bidsBySeat = { N: [], E: [], S: [], W: [] };
  for (let i = 0; i < auction.length; i++) {
    bidsBySeat[POSITIONS[(dealerIdx + i) % 4]].push(auction[i]);
  }

  // ---- Declarer + leader (derived from contract) ----
  let declarer = null, dummy = null, leaderSeat = null, partnerSeat = null;
  if (contract) {
    let lastBidIdx = -1;
    for (let i = auction.length - 1; i >= 0; i--) {
      if (auction[i].type === 'bid') { lastBidIdx = i; break; }
    }
    if (lastBidIdx >= 0) {
      const lastBidderIdx = (dealerIdx + lastBidIdx) % 4;
      const declSide = lastBidderIdx % 2; // 0 = NS, 1 = EW
      for (let i = 0; i < auction.length; i++) {
        if (auction[i].type !== 'bid') continue;
        if (auction[i].denom !== contract.denom) continue;
        const bidderIdx = (dealerIdx + i) % 4;
        if (bidderIdx % 2 !== declSide) continue;
        declarer = POSITIONS[bidderIdx];
        break;
      }
      if (!declarer) declarer = POSITIONS[lastBidderIdx];
      const dIdx = POS_INDEX[declarer];
      dummy = POSITIONS[(dIdx + 2) % 4];
      leaderSeat = POSITIONS[(dIdx + 1) % 4];
      partnerSeat = POSITIONS[(dIdx + 3) % 4];
    }
  }

  // ---- Sides — relative to leader (or default South) ----
  const refLeader = leaderSeat || 'S';
  const refIdx = POS_INDEX[refLeader];
  const partnerIdxN = (refIdx + 2) % 4;

  const collect = (seats) => {
    const set = new Set();
    for (const s of seats) for (const b of bidsBySeat[s]) {
      if (b.type === 'bid' && b.denom !== 'NT') set.add(b.denom);
    }
    return ['S', 'H', 'D', 'C'].filter((d) => set.has(d));
  };
  const partnerSuits = collect([POSITIONS[partnerIdxN]]);
  const leaderSuits = collect([POSITIONS[refIdx]]);
  const declarerSuits = collect([POSITIONS[(refIdx + 1) % 4], POSITIONS[(refIdx + 3) % 4]]);
  const allBidSuits = collect(POSITIONS);
  const unbidSuits = allBidSuits.length > 0
    ? ['S', 'H', 'D', 'C'].filter((d) => !allBidSuits.includes(d))
    : []; // no auction info → no unbid signal

  // ---- Doubles classification (takeout-shape heuristic) ----
  let byDefenderSide = false, byDeclarerSide = false;
  for (let i = 0; i < auction.length; i++) {
    const b = auction[i];
    if (b.type !== 'dbl') continue;
    let dIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (auction[j].type === 'bid') { dIdx = j; break; }
      if (auction[j].type === 'dbl' || auction[j].type === 'rdbl') break;
    }
    if (dIdx < 0) continue;
    const doubledBid = auction[dIdx];
    if (doubledBid.denom === 'NT' || doubledBid.level > 2) continue;
    const doublerIdx = (dealerIdx + i) % 4;
    const doublerSeat = POSITIONS[doublerIdx];
    const priorReals = [];
    for (const x of bidsBySeat[doublerSeat]) {
      if (x === b) break;
      if (x.type === 'bid') priorReals.push(x);
    }
    const isTakeout = priorReals.length === 0
      || (priorReals.length === 1 && priorReals[0].level === 1);
    if (!isTakeout) continue;
    if (doublerIdx % 2 === refIdx % 2) byDefenderSide = true;
    else byDeclarerSide = true;
  }

  // ---- Pass-through flags ----
  const partnerBids = bidsBySeat[POSITIONS[partnerIdxN]];
  const leaderBids = bidsBySeat[POSITIONS[refIdx]];
  const partnerPassedThroughout = partnerBids.length > 0
    && partnerBids.every((x) => x.type === 'pass');
  const leaderPassedThroughout = leaderBids.length > 0
    && leaderBids.every((x) => x.type === 'pass');

  // ---- Human-readable summary ----
  const summary = [];
  if (contract && declarer) {
    const onLead = leaderSeat && leaderSeat !== 'S' ? ` — ${leaderSeat} on lead` : '';
    summary.push(`Final contract: ${contract.level}${SYM[contract.denom]} by ${declarer}${onLead}`);
  }
  if (declarerSuits.length) summary.push(`Declarer side bid: ${declarerSuits.map((s) => SYM[s]).join(' ')}`);
  if (partnerSuits.length) summary.push(`Partner bid: ${partnerSuits.map((s) => SYM[s]).join(' ')}`);
  if (unbidSuits.length === 1) summary.push(`Only ${SYM[unbidSuits[0]]} unbid — strong unbid-suit signal`);
  else if (unbidSuits.length === 2) summary.push(`Unbid: ${unbidSuits.map((s) => SYM[s]).join(' ')}`);
  if (byDefenderSide) summary.push('Takeout-shape X by defender side — partner suggests length in unbid suits');
  if (byDeclarerSide) summary.push('Takeout-shape X by declarer side — declarer/dummy suggest length in unbid suits');
  if (partnerPassedThroughout) {
    const isNT = contract && contract.denom === 'NT';
    summary.push(isNT
      ? 'Partner passed throughout — limited entries for partner'
      : 'Partner passed throughout — limited entries; ruff-seeking devalued');
  }

  return {
    contract, declarer, dummy, leaderSeat, partnerSeat, dealer,
    bidsBySeat, declarerSuits, partnerSuits, leaderSuits, unbidSuits,
    doubles: { byDefenderSide, byDeclarerSide },
    partnerPassedThroughout, leaderPassedThroughout,
    summary,
  };
}
