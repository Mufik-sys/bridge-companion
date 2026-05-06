/* Live Play tab — card-by-card trick tracker with constraint inference and
   heuristic next-card hints. v2.3.

   Three phases:
     'setup' — enter contract (auto from auction or manual), my hand, optional dummy
     'play'  — trick-by-trick recording with running inferences + hints
     'done'  — trick 13 complete; show breakdown, allow reset

   Persists to localStorage so reloads don't wipe the deal.

   Design notes per CLAUDE.md:
   - Mobile-first; trick strip is sticky at top
   - Hover effects gated to (hover: hover) — already inherited from styles const
   - Tap targets ≥40px tall
   - Reasoning shown alongside recommendation, not just the card */

import { useState, useMemo, useEffect } from 'react';
import { RotateCcw, Info, ChevronDown, ChevronUp, Eye, Undo2 } from 'lucide-react';
import {
  POSITIONS, POS_INDEX, SYM, SUIT_LIST, RANKS_DESC, RANK_VAL,
  PlayerColors, parseHolding, deriveContract, deriveLeadContext, handHCP,
} from './sharedHelpers.js';
import { ContractPicker, SuitInput } from './uiComponents.jsx';
import { buildConstraints, applyPlay, summarize, possibleHolders, unseenCountBySuit, trickWinner } from './engines/inference.js';
import { recommendNextCard } from './engines/play.js';

const STORAGE_KEY = 'bridge-companion-deal-v1';
const SCHEMA_VERSION = 1;

const initialDealState = () => ({
  schemaVersion: SCHEMA_VERSION,
  phase: 'setup',
  manualContract: { level: 4, denom: 'S' },
  manualDeclarer: null,
  myHandRaw: { S: '', H: '', D: '', C: '' },
  dummyHandRaw: { S: '', H: '', D: '', C: '' },
  dummyEntered: false,
  tricks: [],
  currentTrick: { leader: null, plays: [] },
  trickNumber: 1,
});

/* Convert raw text holdings to a list of {suit, rank} cards. */
function rawToCards(raw) {
  const out = [];
  for (const s of SUIT_LIST) for (const r of parseHolding(raw[s] || '')) out.push({ suit: s, rank: r });
  return out;
}

/* ---- Persistence: debounced localStorage save ---- */
function useDealStorage(state, setState) {
  // Load once on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed.schemaVersion !== SCHEMA_VERSION) return;
      setState(parsed);
    } catch (_) { /* ignore corrupt storage */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save on change, debounced 200ms
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
    }, 200);
    return () => clearTimeout(t);
  }, [state]);
}

export default function LivePlayTab({ auction, dealer }) {
  const [deal, setDeal] = useState(initialDealState);
  useDealStorage(deal, setDeal);

  // Derive effective contract + declarer
  const auctionContract = useMemo(() => deriveContract(auction || []), [auction]);
  const auctionLC = useMemo(
    () => deriveLeadContext(auction || [], dealer || 'N', auctionContract),
    [auction, dealer, auctionContract],
  );
  const useAuctionContext = !!(auctionContract && auctionLC.declarer);
  const effectiveContract = useAuctionContext ? auctionContract : deal.manualContract;
  const effectiveDeclarer = useAuctionContext ? auctionLC.declarer : (deal.manualDeclarer || 'N');
  const dummySeat = useAuctionContext
    ? auctionLC.dummy
    : POSITIONS[(POS_INDEX[effectiveDeclarer] + 2) % 4];
  const openingLeader = useAuctionContext
    ? auctionLC.leaderSeat
    : POSITIONS[(POS_INDEX[effectiveDeclarer] + 1) % 4];

  const myCards = useMemo(() => rawToCards(deal.myHandRaw), [deal.myHandRaw]);
  const myHCP = handHCP(myCards);
  const dummyCards = useMemo(() => deal.dummyEntered ? rawToCards(deal.dummyHandRaw) : null, [deal.dummyEntered, deal.dummyHandRaw]);

  // Reset / clear
  const resetAll = () => {
    if (!confirm('Reset Live Play deal? This clears your hand, dummy, all tricks.')) return;
    setDeal(initialDealState());
  };

  if (deal.phase === 'setup') {
    return (
      <SetupView
        deal={deal}
        setDeal={setDeal}
        useAuctionContext={useAuctionContext}
        auctionContract={auctionContract}
        auctionLC={auctionLC}
        effectiveContract={effectiveContract}
        effectiveDeclarer={effectiveDeclarer}
        myCards={myCards}
        myHCP={myHCP}
      />
    );
  }

  if (deal.phase === 'done') {
    return <DoneView deal={deal} effectiveContract={effectiveContract} effectiveDeclarer={effectiveDeclarer} resetAll={resetAll} />;
  }

  return (
    <PlayView
      deal={deal}
      setDeal={setDeal}
      auction={auction || []}
      dealer={dealer || 'N'}
      effectiveContract={effectiveContract}
      effectiveDeclarer={effectiveDeclarer}
      dummySeat={dummySeat}
      openingLeader={openingLeader}
      myCards={myCards}
      dummyCards={dummyCards}
      auctionLC={auctionLC}
      resetAll={resetAll}
    />
  );
}

/* =========================================================
   SETUP VIEW
   ========================================================= */
function SetupView({ deal, setDeal, useAuctionContext, auctionContract, auctionLC, effectiveContract, effectiveDeclarer, myCards, myHCP }) {
  const [showManual, setShowManual] = useState(!useAuctionContext);
  const totalCards = myCards.length;

  const startPlay = () => {
    const leader = useAuctionContext
      ? auctionLC.leaderSeat
      : POSITIONS[(POS_INDEX[effectiveDeclarer] + 1) % 4];
    setDeal({
      ...deal,
      phase: 'play',
      currentTrick: { leader, plays: [] },
      trickNumber: 1,
    });
  };

  const setRaw = (which, suit, value) => setDeal({ ...deal, [which]: { ...deal[which], [suit]: value } });

  return (
    <div className="space-y-5">
      <div>
        <h2 className="display text-2xl mb-1">Live Play</h2>
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          Tap each card as it's played; the engine tracks constraints and hints your next card.
        </div>
      </div>

      <div className="card-tile rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="display text-xl">Contract</h3>
          {effectiveContract && (
            <div className="text-sm data" style={{ color: 'var(--muted)' }}>
              <span style={{ color: 'var(--ink)' }}>{effectiveContract.level}</span>
              <span className={effectiveContract.denom === 'H' || effectiveContract.denom === 'D' ? 'red-suit' : 'blk-suit'} style={{ marginLeft: 2 }}>
                {SYM[effectiveContract.denom]}
              </span>
              <span style={{ marginLeft: 8 }}>by {effectiveDeclarer}</span>
            </div>
          )}
        </div>
        {useAuctionContext ? (
          <div className="text-[12px] leading-relaxed" style={{ color: 'var(--ink-soft)' }}>
            <div style={{ color: 'var(--felt)' }} className="mb-1">✓ Using auction from Auction Advisor</div>
            <ul className="space-y-0.5 mt-1">
              {auctionLC.summary.slice(0, 4).map((s, i) => <li key={i}>· {s}</li>)}
            </ul>
            <button
              onClick={() => setShowManual(!showManual)}
              className="mt-2 pill-btn rounded-md px-3 py-1.5 text-xs"
            >
              {showManual ? 'Hide' : 'Override manually'}
            </button>
          </div>
        ) : (
          <div className="text-[12px] leading-relaxed" style={{ color: 'var(--muted)' }}>
            No completed auction in the Auction Advisor tab — set the contract manually below.
          </div>
        )}
        {(showManual || !useAuctionContext) && (
          <div className="mt-3 space-y-3" style={{ borderTop: useAuctionContext ? '1px solid var(--line-soft)' : 'none', paddingTop: useAuctionContext ? 12 : 0 }}>
            <ContractPicker
              contract={deal.manualContract}
              setContract={(c) => setDeal({ ...deal, manualContract: c })}
            />
            <div>
              <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--muted)' }}>Declarer</div>
              <div className="flex gap-1">
                {POSITIONS.map((p) => (
                  <button
                    key={p}
                    onClick={() => setDeal({ ...deal, manualDeclarer: p })}
                    className={`pill-btn rounded-md flex-1 py-2 display text-base ${(deal.manualDeclarer || 'N') === p ? 'active' : ''}`}
                  >{p}</button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="card-tile rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="display text-xl">Your hand (S)</h3>
          <div className="text-xs data" style={{ color: totalCards === 13 ? 'var(--felt)' : 'var(--burgundy)' }}>
            {totalCards}/13 · {myHCP} HCP
          </div>
        </div>
        <div className="space-y-2">
          {SUIT_LIST.map((s) => (
            <SuitInput key={s} suit={s} value={deal.myHandRaw[s]} onChange={(v) => setRaw('myHandRaw', s, v)} />
          ))}
        </div>
        <div className="mt-2 text-[11px]" style={{ color: 'var(--muted)' }}>
          Use 10 or T for ten. Order doesn't matter.
        </div>
      </div>

      <div className="card-tile rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="display text-xl">Dummy's hand (optional)</h3>
          {deal.dummyEntered && (
            <button onClick={() => setDeal({ ...deal, dummyEntered: false, dummyHandRaw: { S:'', H:'', D:'', C:'' } })} className="text-xs" style={{ color: 'var(--muted)' }}>
              Skip dummy
            </button>
          )}
        </div>
        {!deal.dummyEntered ? (
          <button
            onClick={() => setDeal({ ...deal, dummyEntered: true })}
            className="pill-btn rounded-md px-4 py-2 text-sm"
          >
            Enter dummy's hand
          </button>
        ) : (
          <div className="space-y-2">
            {SUIT_LIST.map((s) => (
              <SuitInput key={s} suit={s} value={deal.dummyHandRaw[s]} onChange={(v) => setRaw('dummyHandRaw', s, v)} />
            ))}
            <div className="text-[11px] mt-1" style={{ color: 'var(--muted)' }}>
              Enter when dummy comes down. More accurate inference if entered, but never required.
            </div>
          </div>
        )}
      </div>

      <button
        onClick={startPlay}
        disabled={totalCards !== 13 || !effectiveContract}
        className="w-full chip-btn rounded-lg py-3 display text-lg"
        style={{ background: totalCards === 13 && effectiveContract ? 'var(--felt)' : 'var(--paper-2)', color: totalCards === 13 && effectiveContract ? 'var(--paper)' : 'var(--muted)' }}
      >
        Start playing →
      </button>
    </div>
  );
}

/* =========================================================
   PLAY VIEW
   ========================================================= */
function PlayView({ deal, setDeal, auction, dealer, effectiveContract, effectiveDeclarer, dummySeat, openingLeader, myCards, dummyCards, auctionLC, resetAll }) {
  const [showInferences, setShowInferences] = useState(false);
  const [showHint, setShowHint] = useState(true);

  const trumpDenom = effectiveContract.denom === 'NT' ? null : effectiveContract.denom;

  // Compute remaining cards in my hand and dummy after all played plays
  const allPlays = [...deal.tricks.flatMap((t) => t.plays), ...deal.currentTrick.plays];
  const playedCardIds = new Set(allPlays.map((p) => p.card.rank + p.card.suit));
  const myRemaining = myCards.filter((c) => !playedCardIds.has(c.rank + c.suit));
  const dummyRemaining = dummyCards ? dummyCards.filter((c) => !playedCardIds.has(c.rank + c.suit)) : null;

  // Build constraints from scratch each render — cheap, idempotent
  const constraints = useMemo(() => {
    const lc = deriveLeadContext(auction, dealer, effectiveContract);
    let c = buildConstraints({
      myHand: myCards,
      dummyHand: dummyCards,
      dummySeat: dummyCards ? dummySeat : null,
      auction, dealer, leadContext: lc,
    });
    // Replay all completed tricks
    const tricksPlayedBySeat = { N: 0, E: 0, S: 0, W: 0 };
    let unseen = unseenCountBySuit(c);
    for (const trick of deal.tricks) {
      const tempTrick = { leader: trick.leader, plays: [] };
      for (const p of trick.plays) {
        c = applyPlay(c, { seat: p.seat, card: p.card }, tempTrick, tricksPlayedBySeat, unseen);
        tempTrick.plays.push(p);
        unseen = unseenCountBySuit(c);
      }
      tricksPlayedBySeat[trick.winner]++;
    }
    // Replay current (incomplete) trick
    const tempTrick = { leader: deal.currentTrick.leader, plays: [] };
    for (const p of deal.currentTrick.plays) {
      c = applyPlay(c, { seat: p.seat, card: p.card }, tempTrick, tricksPlayedBySeat, unseen);
      tempTrick.plays.push(p);
      unseen = unseenCountBySuit(c);
    }
    return c;
  }, [auction, dealer, effectiveContract, myCards, dummyCards, dummySeat, deal.tricks, deal.currentTrick]);

  // Whose turn? leader of current trick + plays.length, clockwise
  const turnIdx = (POS_INDEX[deal.currentTrick.leader] + deal.currentTrick.plays.length) % 4;
  const turnSeat = POSITIONS[turnIdx];

  // What was led (if any)?
  const ledSuit = deal.currentTrick.plays.length > 0 ? deal.currentTrick.plays[0].card.suit : null;

  // Trick counts
  const declarerSide = [effectiveDeclarer, dummySeat];
  const declarerTricks = deal.tricks.filter((t) => declarerSide.includes(t.winner)).length;
  const defenseTricks = deal.tricks.length - declarerTricks;

  // Hint for current turn
  const hint = useMemo(() => {
    let ownHand = null;
    if (turnSeat === 'S') ownHand = myRemaining;
    else if (turnSeat === dummySeat && dummyRemaining) ownHand = dummyRemaining;
    return recommendNextCard({
      constraints,
      currentTrick: deal.currentTrick,
      mySeat: turnSeat,
      ownHand,
      contract: effectiveContract,
      leadContext: auctionLC,
      unseenBySuit: unseenCountBySuit(constraints),
    });
  }, [constraints, deal.currentTrick, turnSeat, myRemaining, dummyRemaining, dummySeat, effectiveContract, auctionLC]);

  // Possible holders for the unseen grid
  const holders = useMemo(() => possibleHolders(constraints), [constraints]);

  /* ---- Tap a card → record it for the current turn ---- */
  const playCard = (cardObj) => {
    const newTrick = { ...deal.currentTrick, plays: [...deal.currentTrick.plays, { seat: turnSeat, card: cardObj }] };

    if (newTrick.plays.length < 4) {
      setDeal({ ...deal, currentTrick: newTrick });
      return;
    }

    // Trick complete → determine winner, advance
    const winner = trickWinner({ leader: newTrick.leader, plays: newTrick.plays }, trumpDenom);
    const completedTrick = { leader: newTrick.leader, plays: newTrick.plays, winner };
    const newTricks = [...deal.tricks, completedTrick];
    const isLast = newTricks.length === 13;
    setDeal({
      ...deal,
      tricks: newTricks,
      currentTrick: isLast ? { leader: null, plays: [] } : { leader: winner, plays: [] },
      trickNumber: isLast ? 13 : deal.trickNumber + 1,
      phase: isLast ? 'done' : 'play',
    });
  };

  /* ---- Undo last card ---- */
  const undoLast = () => {
    if (deal.currentTrick.plays.length > 0) {
      setDeal({ ...deal, currentTrick: { ...deal.currentTrick, plays: deal.currentTrick.plays.slice(0, -1) } });
      return;
    }
    if (deal.tricks.length === 0) return;
    // Roll back last completed trick: take its 4th play out, set as in-progress
    const last = deal.tricks[deal.tricks.length - 1];
    setDeal({
      ...deal,
      tricks: deal.tricks.slice(0, -1),
      currentTrick: { leader: last.leader, plays: last.plays.slice(0, 3) },
      trickNumber: deal.trickNumber - 1,
    });
  };

  return (
    <div className="space-y-3">
      {/* Sticky trick strip */}
      <div className="sticky-strip rounded-lg p-3" style={{ background: 'var(--paper)', border: '1px solid var(--line)', position: 'sticky', top: 0, zIndex: 10 }}>
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs data" style={{ color: 'var(--muted)' }}>
            Trick {deal.trickNumber} · Leader {deal.currentTrick.leader}
          </div>
          <div className="text-xs flex items-center gap-2" style={{ color: 'var(--muted)' }}>
            <span><span className="data" style={{ color: 'var(--felt)' }}>{declarerTricks}</span> declarer</span>
            <span>·</span>
            <span><span className="data" style={{ color: 'var(--burgundy)' }}>{defenseTricks}</span> defense</span>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {POSITIONS.map((seat) => {
            const play = deal.currentTrick.plays.find((p) => p.seat === seat);
            const isTurn = seat === turnSeat;
            const isLeader = seat === deal.currentTrick.leader;
            return (
              <div
                key={seat}
                className="card-tile rounded-md p-2 text-center"
                style={{
                  borderColor: isTurn ? 'var(--felt)' : isLeader ? 'var(--burgundy)' : 'var(--line)',
                  borderWidth: isTurn || isLeader ? 2 : 1,
                  background: isTurn ? 'var(--paper-2)' : 'var(--paper)',
                  minHeight: 64,
                }}
              >
                <div className="text-[10px] uppercase tracking-wider data" style={{ color: PlayerColors[seat].bg }}>{seat}{seat === effectiveDeclarer ? ' D' : seat === dummySeat ? ' d' : ''}</div>
                <div className="display text-xl mt-1">
                  {play ? (
                    <span className="data">
                      {play.card.rank === 'T' ? '10' : play.card.rank}
                      <span className={play.card.suit === 'H' || play.card.suit === 'D' ? 'red-suit' : 'blk-suit'}>{SYM[play.card.suit]}</span>
                    </span>
                  ) : (
                    <span style={{ color: 'var(--line)' }}>·</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex justify-between mt-2 items-center">
          <button onClick={resetAll} className="pill-btn rounded-full px-3 py-1 text-[11px] flex items-center gap-1">
            <RotateCcw size={11} /> Reset deal
          </button>
          <button onClick={undoLast} className="pill-btn rounded-full px-3 py-1 text-[11px] flex items-center gap-1">
            <Undo2 size={11} /> Undo
          </button>
        </div>
      </div>

      {/* Hint panel */}
      {showHint && hint && (
        <div className="recommendation rounded-lg p-3">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--burgundy)' }}>
              Suggested for {turnSeat}
            </div>
            <button onClick={() => setShowHint(false)} className="text-[10px]" style={{ color: 'var(--muted)' }}>hide</button>
          </div>
          {hint.card ? (
            <div className="display text-2xl">
              <span className="data">{hint.card.rank === 'T' ? '10' : hint.card.rank}</span>
              <span className={hint.card.suit === 'H' || hint.card.suit === 'D' ? 'red-suit' : 'blk-suit'} style={{ marginLeft: 2 }}>{SYM[hint.card.suit]}</span>
              <span className="text-xs ml-3" style={{ color: 'var(--muted)' }}>{hint.rule} · {hint.confidence}</span>
            </div>
          ) : (
            <div className="text-sm" style={{ color: 'var(--muted)' }}>No clear hint</div>
          )}
          <div className="text-xs leading-relaxed mt-1" style={{ color: 'var(--ink-soft)' }}>{hint.reasoning}</div>
        </div>
      )}
      {!showHint && (
        <button onClick={() => setShowHint(true)} className="pill-btn rounded-md px-3 py-1.5 text-xs flex items-center gap-1">
          <Eye size={12} /> Show hint
        </button>
      )}

      {/* Tap zone — own hand if turn is mine/dummy, else unseen grid */}
      {turnSeat === 'S' ? (
        <HandTapZone label="Your hand" cards={myRemaining} ledSuit={ledSuit} onTap={playCard} />
      ) : turnSeat === dummySeat && dummyRemaining ? (
        <HandTapZone label={`Dummy (${dummySeat})`} cards={dummyRemaining} ledSuit={ledSuit} onTap={playCard} />
      ) : (
        <UnseenGrid
          turnSeat={turnSeat}
          ledSuit={ledSuit}
          holders={holders}
          constraints={constraints}
          onTap={playCard}
          playedCardIds={playedCardIds}
          myCardIds={new Set(myCards.map((c) => c.rank + c.suit))}
          dummyCardIds={dummyCards ? new Set(dummyCards.map((c) => c.rank + c.suit)) : new Set()}
        />
      )}

      {/* Hand strips (always visible) */}
      <div className="card-tile rounded-lg p-3">
        <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--muted)' }}>Your hand (S)</div>
        <HandRow cards={myRemaining} dim={turnSeat !== 'S'} />
      </div>
      {dummyCards && (
        <div className="card-tile rounded-lg p-3">
          <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--muted)' }}>Dummy ({dummySeat})</div>
          <HandRow cards={dummyRemaining} dim={turnSeat !== dummySeat} />
        </div>
      )}

      {/* Inferences toggle panel */}
      <button
        onClick={() => setShowInferences(!showInferences)}
        className="pill-btn rounded-md w-full py-2 text-xs flex items-center justify-center gap-1.5"
      >
        {showInferences ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        {showInferences ? 'Hide' : 'Show'} inferences
      </button>
      {showInferences && <InferencesPanel constraints={constraints} />}

      <div className="text-[11px] leading-relaxed" style={{ color: 'var(--muted)' }}>
        <Info size={11} className="inline -mt-0.5 mr-1" />
        Heuristic — engine doesn't simulate. Hint rules: forced play, cash known winner, 3rd hand high, 2nd hand low. More rules in a follow-up.
      </div>
    </div>
  );
}

/* Group cards by suit, sort high to low. */
function bySuit(cards) {
  const out = { S: [], H: [], D: [], C: [] };
  for (const c of cards) out[c.suit].push(c);
  for (const s of SUIT_LIST) out[s].sort((a, b) => RANK_VAL[b.rank] - RANK_VAL[a.rank]);
  return out;
}

function HandTapZone({ label, cards, ledSuit, onTap }) {
  const grouped = bySuit(cards);
  // Suit-following: if led and we have any in that suit, only those are tappable
  const followers = ledSuit ? grouped[ledSuit] : null;
  const mustFollow = followers && followers.length > 0;
  return (
    <div className="card-tile rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted)' }}>
        {label} — tap card to play{mustFollow ? ` (must follow ${SYM[ledSuit]})` : ''}
      </div>
      <div className="space-y-1.5">
        {SUIT_LIST.map((s) => (
          <div key={s} className="flex items-center gap-2">
            <span className={`text-base w-5 text-center ${s === 'H' || s === 'D' ? 'red-suit' : 'blk-suit'}`}>{SYM[s]}</span>
            <div className="flex flex-wrap gap-1">
              {grouped[s].length === 0 ? (
                <span className="text-xs" style={{ color: 'var(--line)' }}>—</span>
              ) : grouped[s].map((c) => {
                const dim = mustFollow && s !== ledSuit;
                return (
                  <button
                    key={c.rank + c.suit}
                    onClick={() => !dim && onTap(c)}
                    disabled={dim}
                    className="chip-btn rounded px-2 py-1 text-sm data"
                    style={{ opacity: dim ? 0.3 : 1, minWidth: 32 }}
                  >
                    {c.rank === 'T' ? '10' : c.rank}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HandRow({ cards, dim }) {
  const grouped = bySuit(cards || []);
  return (
    <div className="space-y-1" style={{ opacity: dim ? 0.6 : 1 }}>
      {SUIT_LIST.map((s) => (
        <div key={s} className="flex items-center gap-2">
          <span className={`text-base w-5 text-center ${s === 'H' || s === 'D' ? 'red-suit' : 'blk-suit'}`}>{SYM[s]}</span>
          <div className="text-sm data flex-1">
            {grouped[s].length === 0 ? '—' : grouped[s].map((c) => c.rank === 'T' ? '10' : c.rank).join(' ')}
          </div>
        </div>
      ))}
    </div>
  );
}

function UnseenGrid({ turnSeat, ledSuit, holders, constraints, onTap, playedCardIds, myCardIds, dummyCardIds }) {
  // For each suit, render row of 13 cells; mark played, my-hand, dummy-hand, and impossible-for-this-seat
  return (
    <div className="card-tile rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted)' }}>
        Tap card {turnSeat} played{ledSuit ? ` (led: ${SYM[ledSuit]})` : ''}
      </div>
      <div className="space-y-1.5">
        {SUIT_LIST.map((s) => (
          <div key={s} className="flex items-center gap-1">
            <span className={`text-base w-5 text-center ${s === 'H' || s === 'D' ? 'red-suit' : 'blk-suit'}`}>{SYM[s]}</span>
            <div className="flex gap-0.5 flex-wrap">
              {RANKS_DESC.map((r) => {
                const id = r + s;
                const played = playedCardIds.has(id);
                const inMine = myCardIds.has(id);
                const inDummy = dummyCardIds.has(id);
                const possible = !played && !inMine && !inDummy
                  && holders[id] && holders[id].has(turnSeat);
                // Strike-through if engine thinks this seat can't have it but card is unseen
                const impossible = !played && !inMine && !inDummy && !possible;
                // Suit-following: must-follow → only ledSuit cards tappable
                const mustFollowConflict = ledSuit && s !== ledSuit
                  && SUIT_LIST.some((other) => other === ledSuit && constraints[turnSeat][ledSuit].maxLen > 0);
                const tappable = !played && !inMine && !inDummy && !mustFollowConflict;
                return (
                  <button
                    key={r}
                    onClick={() => tappable && onTap({ rank: r, suit: s })}
                    disabled={!tappable}
                    className="chip-btn rounded text-xs data"
                    style={{
                      width: 22, height: 24,
                      opacity: played || inMine || inDummy ? 0.2 : impossible ? 0.4 : 1,
                      textDecoration: impossible ? 'line-through' : 'none',
                      padding: 0,
                    }}
                    title={played ? 'played' : inMine ? 'in your hand' : inDummy ? 'in dummy' : impossible ? 'engine: this seat probably does not have it' : ''}
                  >
                    {r === 'T' ? 'X' : r}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="text-[10px] mt-2" style={{ color: 'var(--muted)' }}>
        Strike-through = engine thinks {turnSeat} can't have it. Still tappable in case the engine is wrong.
      </div>
    </div>
  );
}

function InferencesPanel({ constraints }) {
  const sum = summarize(constraints);
  return (
    <div className="card-tile rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted)' }}>What the engine thinks</div>
      <div className="space-y-1.5">
        {POSITIONS.map((seat) => (
          <div key={seat} className="flex items-baseline gap-2 text-xs">
            <span className="display text-sm w-5" style={{ color: PlayerColors[seat].bg }}>{seat}</span>
            <span className="data flex-1" style={{ color: 'var(--ink-soft)' }}>{sum[seat]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* =========================================================
   DONE VIEW
   ========================================================= */
function DoneView({ deal, effectiveContract, effectiveDeclarer, resetAll }) {
  const dummySeat = POSITIONS[(POS_INDEX[effectiveDeclarer] + 2) % 4];
  const declarerSide = [effectiveDeclarer, dummySeat];
  const declarerTricks = deal.tricks.filter((t) => declarerSide.includes(t.winner)).length;
  const defenseTricks = 13 - declarerTricks;
  const tricksNeeded = effectiveContract.level + 6;
  const result = declarerTricks >= tricksNeeded
    ? `Made${declarerTricks > tricksNeeded ? ' +' + (declarerTricks - tricksNeeded) : ''}`
    : `Down ${tricksNeeded - declarerTricks}`;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="display text-2xl mb-1">Deal complete</h2>
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          {effectiveContract.level}{SYM[effectiveContract.denom]} by {effectiveDeclarer}
        </div>
      </div>
      <div className="recommendation rounded-lg p-4">
        <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--burgundy)' }}>Result</div>
        <div className="display text-3xl mb-2">{result}</div>
        <div className="text-sm" style={{ color: 'var(--ink-soft)' }}>
          Declarer took <span className="data">{declarerTricks}</span>, defense took <span className="data">{defenseTricks}</span>. Needed <span className="data">{tricksNeeded}</span>.
        </div>
      </div>
      <div className="text-[11px] leading-relaxed" style={{ color: 'var(--muted)' }}>
        <Info size={11} className="inline -mt-0.5 mr-1" />
        Result computed from trick count only — vulnerability/doubled scoring not yet computed (next iteration).
      </div>
      <button onClick={resetAll} className="w-full pill-btn rounded-lg py-3 display text-base flex items-center justify-center gap-2">
        <RotateCcw size={14} /> Start new deal
      </button>
    </div>
  );
}
