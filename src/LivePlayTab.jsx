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
import { buildConstraints, applyPlay, possibleHolders, unseenCountBySuit, trickWinner } from './engines/inference.js';
import { recommendNextCard } from './engines/play.js';

const STORAGE_KEY = 'bridge-companion-deal-v1';
// Bumped to 2 in v2.4 — added uiPrefs. Older state with schemaVersion 1
// will be discarded on load (one-time wipe; user re-enters their hand).
const SCHEMA_VERSION = 2;

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
  // v2.4: persisted UI toggle state. Defaults match the spec —
  // HCP played hidden (extra info on demand), inferences expanded
  // (their data informs the play; user wants to see it), hint visible.
  uiPrefs: {
    showHcpPlayed: false,
    showInferences: true,
    showHint: true,
  },
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
        dummySeat={dummySeat}
        openingLeader={openingLeader}
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
function SetupView({ deal, setDeal, useAuctionContext, auctionContract, auctionLC, effectiveContract, effectiveDeclarer, dummySeat, openingLeader, myCards, myHCP }) {
  const [showManual, setShowManual] = useState(!useAuctionContext);
  const totalCards = myCards.length;
  // BUGFIX v2.3.2: in manual setup, require an explicit declarer choice — no
  // silent default. The previous default of 'N' caused a user-engine mismatch
  // when the user assumed a different declarer.
  const declarerExplicit = useAuctionContext || !!deal.manualDeclarer;
  const setupReady = totalCards === 13 && !!effectiveContract && declarerExplicit;

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
          {effectiveContract && declarerExplicit && (
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
              <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--muted)' }}>
                Declarer {!deal.manualDeclarer && <span style={{ color: 'var(--burgundy)' }}>· required</span>}
              </div>
              <div className="flex gap-1">
                {POSITIONS.map((p) => (
                  <button
                    key={p}
                    onClick={() => setDeal({ ...deal, manualDeclarer: p })}
                    className={`pill-btn rounded-md flex-1 py-2 display text-base ${deal.manualDeclarer === p ? 'active' : ''}`}
                  >{p}</button>
                ))}
              </div>
            </div>
          </div>
        )}
        {/* BUGFIX v2.3.2: prominent seat-role banner so the user can verify
            who's declarer/dummy/leader before entering hands. The previous
            UI never told the user which seat was dummy. */}
        {declarerExplicit && (
          <div className="mt-3 pt-3 flex items-center gap-2 flex-wrap" style={{ borderTop: '1px solid var(--line-soft)' }}>
            <SeatChip seat={effectiveDeclarer} role="Declarer" tone="felt" />
            <SeatChip seat={dummySeat} role="Dummy" tone="burgundy" />
            <SeatChip seat={openingLeader} role="Opens lead" tone="ink" />
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
          <h3 className="display text-xl flex items-center gap-2">
            Dummy's hand
            {declarerExplicit && <SeatChip seat={dummySeat} role="" tone="burgundy" inline />}
            <span className="text-xs" style={{ color: 'var(--muted)', fontWeight: 'normal' }}>(optional)</span>
          </h3>
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
        disabled={!setupReady}
        className="w-full chip-btn rounded-lg py-3 display text-lg"
        style={{ background: setupReady ? 'var(--felt)' : 'var(--paper-2)', color: setupReady ? 'var(--paper)' : 'var(--muted)' }}
      >
        Start playing →
      </button>
      {!setupReady && (
        <div className="text-[11px] text-center" style={{ color: 'var(--muted)' }}>
          {totalCards !== 13 && <div>Need 13 cards in your hand.</div>}
          {!effectiveContract && <div>Need a contract.</div>}
          {!declarerExplicit && <div>Pick declarer above.</div>}
        </div>
      )}
    </div>
  );
}

/* =========================================================
   PLAY VIEW
   ========================================================= */
function PlayView({ deal, setDeal, auction, dealer, effectiveContract, effectiveDeclarer, dummySeat, openingLeader, myCards, dummyCards, auctionLC, resetAll }) {
  // v2.4: toggle state lifted from local useState into deal.uiPrefs so it
  // persists across reloads via useDealStorage.
  const uiPrefs = deal.uiPrefs || { showHcpPlayed: false, showInferences: true, showHint: true };
  const setPref = (key, value) => setDeal({ ...deal, uiPrefs: { ...uiPrefs, [key]: value } });
  const showInferences = uiPrefs.showInferences;
  const showHint = uiPrefs.showHint;
  const showHcpPlayed = uiPrefs.showHcpPlayed;

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
    // Replay all completed tricks. BUGFIX v2.3.1: increment tricksPlayedBySeat
    // per CARD, not per trick-winner. Each seat plays one card per trick, so
    // all four counts should advance together. The previous "winner only"
    // tracking left non-winning seats with stale 0 counts, biasing the
    // per-seat length propagator.
    const tricksPlayedBySeat = { N: 0, E: 0, S: 0, W: 0 };
    let unseen = unseenCountBySuit(c);
    for (const trick of deal.tricks) {
      const tempTrick = { leader: trick.leader, plays: [] };
      for (const p of trick.plays) {
        c = applyPlay(c, { seat: p.seat, card: p.card }, tempTrick, tricksPlayedBySeat, unseen);
        tempTrick.plays.push(p);
        tricksPlayedBySeat[p.seat]++;
        unseen = unseenCountBySuit(c);
      }
    }
    // Replay current (incomplete) trick
    const tempTrick = { leader: deal.currentTrick.leader, plays: [] };
    for (const p of deal.currentTrick.plays) {
      c = applyPlay(c, { seat: p.seat, card: p.card }, tempTrick, tricksPlayedBySeat, unseen);
      tempTrick.plays.push(p);
      tricksPlayedBySeat[p.seat]++;
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
      auction,
      dealer,
      allTricks: deal.tricks,
    });
  }, [constraints, deal.currentTrick, turnSeat, myRemaining, dummyRemaining, dummySeat, effectiveContract, auctionLC, auction, dealer, deal.tricks]);

  // Possible holders for the unseen grid
  const holders = useMemo(() => possibleHolders(constraints), [constraints]);

  /* ---- Tap a card → record it for the current turn ---- */
  const playCard = (cardObj, source = 'unknown') => {
    // DIAGNOSTIC v2.3.2: log every play attempt — helps find the disconnect when
    // a tap in the unseen grid doesn't fire because the engine's dummySeat
    // disagrees with the user's mental dummy seat.
    console.log('[LivePlay tap]', {
      surface: source,
      card: cardObj.rank + cardObj.suit,
      turnSeat,
      currentTrickLeader: deal.currentTrick.leader,
      effectiveDeclarer,
      dummySeat,
      dummyEntered: !!dummyCards,
      knownSeats: ['S', dummyCards ? dummySeat : null].filter(Boolean),
      ledSuit,
      trickNumber: deal.trickNumber,
    });
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

      {/* v2.4: HCP played per seat — toggle (chip-style) + row */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setPref('showHcpPlayed', !showHcpPlayed)}
          className={`pill-btn rounded-full px-3 py-1 text-[11px] flex items-center gap-1 ${showHcpPlayed ? 'active' : ''}`}
        >
          HCP played {showHcpPlayed ? '·' : '+'}
        </button>
        {showHcpPlayed && <HcpPlayedRow constraints={constraints} />}
      </div>

      {/* Hint panel */}
      {showHint && hint && (
        <div className="recommendation rounded-lg p-3">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--burgundy)' }}>
              Suggested for {turnSeat}
            </div>
            <button onClick={() => setPref('showHint', false)} className="text-[10px]" style={{ color: 'var(--muted)' }}>hide</button>
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
        <button onClick={() => setPref('showHint', true)} className="pill-btn rounded-md px-3 py-1.5 text-xs flex items-center gap-1">
          <Eye size={12} /> Show hint
        </button>
      )}

      {/* Tap zone — own hand if turn is mine/dummy, else unseen grid */}
      {turnSeat === 'S' ? (
        <HandTapZone label="Your hand" cards={myRemaining} ledSuit={ledSuit} onTap={(c) => playCard(c, 'my-hand-strip')} />
      ) : turnSeat === dummySeat && dummyRemaining ? (
        <HandTapZone label={`Dummy (${dummySeat})`} cards={dummyRemaining} ledSuit={ledSuit} onTap={(c) => playCard(c, 'dummy-hand-strip')} />
      ) : (
        <UnseenGrid
          turnSeat={turnSeat}
          ledSuit={ledSuit}
          holders={holders}
          constraints={constraints}
          onTap={(c) => playCard(c, 'unseen-grid')}
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

      {/* Cards-out panel (Bug 3) — quick visibility into ranks already played per suit */}
      <CardsOutPanel tricks={deal.tricks} currentTrick={deal.currentTrick} />

      {/* Trick log (Bug 2) — most-recent trick at top, collapsible */}
      <TrickLog tricks={deal.tricks} declarerSide={declarerSide} />

      {/* v2.4: Inferred distribution panel — collapsible, expanded by default */}
      <InferredDistribution
        constraints={constraints}
        dummySeat={dummyCards ? dummySeat : null}
        open={showInferences}
        setOpen={(v) => setPref('showInferences', v)}
      />

      <div className="text-[11px] leading-relaxed" style={{ color: 'var(--muted)' }}>
        <Info size={11} className="inline -mt-0.5 mr-1" />
        Heuristic — engine doesn't simulate. Hint rules: forced, cash, 3rd-high, 2nd-low, leading. More rules in a follow-up.
      </div>
    </div>
  );
}

/* Seat chip: small colored pill showing a seat's role (Declarer / Dummy /
   Opens lead). Visually prominent so users can verify the seating before
   entering hands — root-cause fix for the v2.3.1 "card not tappable" bug
   where the user had a different mental model of dummy than the engine. */
function SeatChip({ seat, role, tone, inline }) {
  const palette = {
    felt: { bg: 'var(--felt)', fg: 'var(--paper)' },
    burgundy: { bg: 'var(--burgundy)', fg: 'var(--paper)' },
    ink: { bg: 'var(--ink)', fg: 'var(--paper)' },
  }[tone] || { bg: 'var(--ink)', fg: 'var(--paper)' };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full ${inline ? 'px-2 py-0.5' : 'px-2.5 py-1'}`}
      style={{ background: palette.bg, color: palette.fg, fontSize: inline ? 11 : 12 }}
    >
      {role && <span style={{ opacity: 0.85 }}>{role}</span>}
      <span className="display" style={{ fontWeight: 600 }}>{seat}</span>
    </span>
  );
}

/* Cards-out summary: for each suit, list ranks already played across all
   completed and current-trick plays. Helps the user see what's still alive. */
function CardsOutPanel({ tricks, currentTrick }) {
  const playedBySuit = { S: [], H: [], D: [], C: [] };
  for (const t of tricks) for (const p of t.plays) playedBySuit[p.card.suit].push(p.card.rank);
  for (const p of currentTrick.plays) playedBySuit[p.card.suit].push(p.card.rank);
  for (const s of SUIT_LIST) playedBySuit[s].sort((a, b) => RANK_VAL[b] - RANK_VAL[a]);

  return (
    <div className="card-tile rounded-lg p-3">
      <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--muted)' }}>Cards out</div>
      <div className="space-y-1">
        {SUIT_LIST.map((s) => (
          <div key={s} className="flex items-center gap-2 text-xs">
            <span className={`text-base w-5 text-center ${s === 'H' || s === 'D' ? 'red-suit' : 'blk-suit'}`}>{SYM[s]}</span>
            <span className="data flex-1" style={{ color: 'var(--ink-soft)' }}>
              {playedBySuit[s].length === 0 ? '—' : playedBySuit[s].map((r) => r === 'T' ? '10' : r).join(' ')}
            </span>
            <span className="text-[10px] data" style={{ color: 'var(--muted)' }}>{playedBySuit[s].length}/13</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* v2.4: Trick log redesigned as cross/diamond layout (matches Funbridge's
   "List of tricks" view).
       N
     W   E
       S
   Plus trick number on the left, winning card highlighted with a colored
   border (felt = declarer side, burgundy = defenders), and a small ▸
   marker next to the leader's seat. Most recent trick at top.
   Pure flexbox — no SVG, no library. ~3 rows per phone screen. */
function TrickLog({ tricks, declarerSide }) {
  const [open, setOpen] = useState(false);
  if (tricks.length === 0) {
    return (
      <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
        <Info size={11} className="inline -mt-0.5 mr-1" />
        No completed tricks yet — they'll appear here as you play.
      </div>
    );
  }
  const reversed = [...tricks].reverse();
  return (
    <div className="card-tile rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-3 text-left"
      >
        <div className="flex items-center gap-2">
          <Info size={14} />
          <span className="display text-base">Trick log</span>
          <span className="text-xs data" style={{ color: 'var(--muted)' }}>({tricks.length} done)</span>
        </div>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="px-3 pb-3 pt-2 space-y-2" style={{ borderTop: '1px solid var(--line-soft)' }}>
          {reversed.map((t, i) => (
            <TrickRow
              key={tricks.length - i}
              trickNum={tricks.length - i}
              trick={t}
              declarerSide={declarerSide}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* Single cross-layout trick row.
     [#3]    ·  N      ▸N
              W   E       ·-bordered = winner
                  S
     [winner: N] */
function TrickRow({ trickNum, trick, declarerSide }) {
  const [showAnnotation, setShowAnnotation] = useState(false);
  const winnerSide = declarerSide.includes(trick.winner) ? 'declarer' : 'defense';
  const winnerColor = winnerSide === 'declarer' ? 'var(--felt)' : 'var(--burgundy)';
  // Map plays to seat for fast lookup
  const playBySeat = {};
  for (const p of trick.plays) playBySeat[p.seat] = p;
  const renderSlot = (seat) => {
    const p = playBySeat[seat];
    const isWinner = trick.winner === seat;
    const isLeader = trick.leader === seat;
    if (!p) return <div style={{ width: 36, height: 26 }} />;
    const isRed = p.card.suit === 'H' || p.card.suit === 'D';
    return (
      <div
        className="rounded data text-xs flex items-center justify-center"
        style={{
          width: 36, height: 26, padding: '0 2px',
          background: 'var(--paper)',
          border: isWinner ? `2px solid ${winnerColor}` : '1px solid var(--line)',
          color: 'var(--ink)',
          boxShadow: isWinner ? `0 0 0 1px ${winnerColor}33` : 'none',
        }}
        title={`${seat}${isLeader ? ' (led)' : ''}${isWinner ? ' (won trick)' : ''}`}
      >
        <span>{p.card.rank === 'T' ? '10' : p.card.rank}</span>
        <span className={isRed ? 'red-suit' : 'blk-suit'} style={{ marginLeft: 1 }}>{SYM[p.card.suit]}</span>
      </div>
    );
  };
  const seatLabel = (seat, position) => {
    const isLeader = trick.leader === seat;
    return (
      <div
        className="text-[9px] data flex items-center gap-0.5"
        style={{ color: PlayerColors[seat].bg, justifyContent: position === 'left' ? 'flex-end' : 'flex-start' }}
      >
        {position === 'left' && isLeader && <span style={{ color: 'var(--burgundy)' }}>▸</span>}
        <span>{seat}</span>
        {position !== 'left' && isLeader && <span style={{ color: 'var(--burgundy)' }}>▸</span>}
      </div>
    );
  };

  return (
    <button
      onClick={() => setShowAnnotation(!showAnnotation)}
      className="w-full flex items-center gap-2 text-left card-tile rounded p-2"
      style={{ background: 'var(--paper-2)', border: '1px solid var(--line-soft)' }}
    >
      {/* Trick number */}
      <div className="data display text-[11px]" style={{ color: 'var(--muted)', minWidth: 24, textAlign: 'right' }}>
        #{trickNum}
      </div>
      {/* Cross diamond: 3 stacked rows of [seat-label, slot, seat-label] */}
      <div className="flex flex-col items-center gap-0.5" style={{ minWidth: 124 }}>
        <div className="flex items-center gap-1">
          {seatLabel('N', 'left')}
          {renderSlot('N')}
        </div>
        <div className="flex items-center gap-1">
          {seatLabel('W', 'left')}
          {renderSlot('W')}
          {renderSlot('E')}
          {seatLabel('E', 'right')}
        </div>
        <div className="flex items-center gap-1">
          {renderSlot('S')}
          {seatLabel('S', 'right')}
        </div>
      </div>
      {/* Winner annotation */}
      <div className="flex-1 text-[10px] data" style={{ color: winnerColor, textAlign: 'right' }}>
        <div>{trick.winner} won</div>
        {showAnnotation && <div style={{ color: 'var(--muted)' }}>{winnerSide}</div>}
      </div>
    </button>
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
                const accountedFor = played || inMine || inDummy;
                // Engine's view: does it think turnSeat could hold this card?
                const possible = !accountedFor && holders[id] && holders[id].has(turnSeat);
                // "Engine disagrees" → either constraints rule out this seat
                //   OR a led suit exists and this card is in a different suit
                //   while engine thinks turnSeat still has the led suit.
                // Both treatments: dim + strike-through, BUT STILL TAPPABLE
                // (the engine is heuristic; the user might know better).
                const impossible = !accountedFor && !possible;
                const mustFollowConflict = !accountedFor && ledSuit && s !== ledSuit
                  && constraints[turnSeat][ledSuit].maxLen > 0;
                const engineDisagrees = impossible || mustFollowConflict;
                // BUGFIX v2.3.1: tappable no longer gated on engineDisagrees —
                // strike-through is visual only, per the v2.3 design.
                const tappable = !accountedFor;
                // BUGFIX v2.3.2: three distinct visual tiers so the user can
                // tell at a glance why a card is dim. Previous treatment had
                // accountedFor at 0.2 with no marker — too easy to confuse
                // with a tappable card.
                //   accountedFor (in mine/dummy/played): opacity 0.15, no marker
                //   engineDisagrees (impossible / must-follow): opacity 0.55,
                //                                             burgundy strike-through, tappable
                //   normal: opacity 1, tappable
                const cellStyle = {
                  width: 22, height: 24,
                  padding: 0,
                  opacity: accountedFor ? 0.15 : engineDisagrees ? 0.55 : 1,
                  textDecorationLine: engineDisagrees ? 'line-through' : 'none',
                  textDecorationColor: engineDisagrees ? 'var(--burgundy)' : undefined,
                  textDecorationThickness: engineDisagrees ? 2 : undefined,
                  background: engineDisagrees ? 'rgba(122, 31, 42, 0.08)' : undefined,
                  color: engineDisagrees ? 'var(--burgundy)' : undefined,
                };
                return (
                  <button
                    key={r}
                    onClick={() => tappable && onTap({ rank: r, suit: s })}
                    disabled={!tappable}
                    className="chip-btn rounded text-xs data"
                    style={cellStyle}
                    title={played ? 'played' : inMine ? 'in your hand' : inDummy ? `in ${turnSeat === 'S' ? 'dummy' : 'a known hand'} — tap from that hand strip` : impossible ? `engine: ${turnSeat} probably does not have this — tap to override` : mustFollowConflict ? `engine: ${turnSeat} should follow ${SYM[ledSuit]} — tap to override` : ''}
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

/* v2.4: HCP played per seat — sums HCP from constraints.playedBy.
   Displayed as a row of 4 mini-pills using each seat's brand color. */
function HcpPlayedRow({ constraints }) {
  const totals = {};
  for (const seat of POSITIONS) {
    let t = 0;
    for (const c of constraints.playedBy[seat] || []) {
      t += { A: 4, K: 3, Q: 2, J: 1 }[c.rank] || 0;
    }
    totals[seat] = t;
  }
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      {POSITIONS.map((seat) => (
        <span
          key={seat}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 data"
          style={{ background: PlayerColors[seat].bg, color: PlayerColors[seat].fg }}
        >
          <span style={{ opacity: 0.85 }}>{seat}</span>
          <span style={{ fontWeight: 600 }}>{totals[seat]}</span>
        </span>
      ))}
    </div>
  );
}

/* v2.4: Inferred distribution — collapsible, expanded by default.
   Per opponent (and partner if not South / dummy if entered):
     [seat] · ♠ range · ♥ range · ♦ range · ♣ range · HCP remaining: X-Y
   Length range formatting: "0" if max=0, "5+" if max=13, single number if
   min=max, otherwise "min-max". */
function InferredDistribution({ constraints, dummySeat, open, setOpen }) {
  const fmtLen = (cell) => {
    if (cell.maxLen === 0) return '0';
    if (cell.minLen === cell.maxLen) return String(cell.minLen);
    if (cell.maxLen >= 13) return `${cell.minLen}+`;
    return `${cell.minLen}-${cell.maxLen}`;
  };
  const fmtHCP = (seat) => {
    const lo = constraints[seat].hcpMin;
    const hi = constraints[seat].hcpMax;
    return lo === hi ? `${lo}` : `${lo}-${hi}`;
  };
  // Show all four seats EXCEPT South (always known) and dummy (known if entered).
  const seatsToShow = POSITIONS.filter((s) => s !== 'S' && s !== dummySeat);

  return (
    <div className="card-tile rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-3 text-left"
      >
        <div className="flex items-center gap-2">
          <Info size={14} />
          <span className="display text-base">Inferred distribution</span>
          <span className="text-xs data" style={{ color: 'var(--muted)' }}>({seatsToShow.length} unknown)</span>
        </div>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2" style={{ borderTop: '1px solid var(--line-soft)' }}>
          {seatsToShow.length === 0 ? (
            <div className="text-[11px]" style={{ color: 'var(--muted)' }}>
              All four hands are known — no inference needed.
            </div>
          ) : seatsToShow.map((seat) => (
            <div key={seat} className="flex items-center gap-2 text-xs flex-wrap">
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 display"
                style={{ background: PlayerColors[seat].bg, color: PlayerColors[seat].fg, fontSize: 11 }}
              >
                {seat}
              </span>
              {SUIT_LIST.map((suit) => (
                <span key={suit} className="flex items-center gap-0.5">
                  <span className={suit === 'H' || suit === 'D' ? 'red-suit' : 'blk-suit'}>{SYM[suit]}</span>
                  <span className="data" style={{ color: 'var(--ink-soft)' }}>{fmtLen(constraints[seat][suit])}</span>
                </span>
              ))}
              <span className="data text-[11px] ml-auto" style={{ color: 'var(--muted)' }}>
                HCP remaining: <span style={{ color: 'var(--ink)' }}>{fmtHCP(seat)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
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
