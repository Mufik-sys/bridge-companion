/* Quick Count tab — minimal-friction card tracker for live play on Funbridge.

   No engine. No constraints. No hints. No declarer/dummy/leader inference.
   Just two-tap card tracking with running per-seat HCP and card counters,
   plus the cross-layout trick log shared with Live Play.

   Tap flow: tap a card in the 4×13 grid → centered modal asks which seat
   played it → tap a seat → counters update, card fades, current-trick
   strip advances. After 4 cards, the engine determines a winner (using
   only the optional trump setting + led suit), logs the trick, and clears
   the strip.

   Persisted under bridge-quickcount-v1 — separate from the Live Play
   localStorage key so the two tabs don't collide. */

import { useState, useEffect, useRef } from 'react';
import { RotateCcw, Undo2 } from 'lucide-react';
import {
  POSITIONS, SYM, SUIT_LIST, RANKS_DESC, RANK_VAL, HONORS_HCP, PlayerColors,
} from './sharedHelpers.js';
import { TrickRow } from './uiComponents.jsx';

const STORAGE_KEY = 'bridge-quickcount-v1';
const SCHEMA_VERSION = 1;

const initialQuickDeal = () => ({
  schemaVersion: SCHEMA_VERSION,
  trump: 'NT',          // 'S'|'H'|'D'|'C'|'NT'; default no trump
  played: {},           // cardId → seat (e.g. 'AS' → 'N')
  trickOrder: [],       // sequence of cardIds in play order
  currentTrickStart: 0, // index in trickOrder where current trick began
  tricks: [],           // [{ leader, plays: [{seat, card}], winner }]
});

const cardId = (suit, rank) => rank + suit;

/* Determine winner of a 4-card trick with the given trump setting.
   Pure function, used both inline (auto-winner on 4th card) and reusable. */
function computeWinner(plays, trump) {
  const ledSuit = plays[0].card.suit;
  let bestIdx = 0;
  for (let i = 1; i < plays.length; i++) {
    const p = plays[i];
    const best = plays[bestIdx];
    const trumpDenom = trump === 'NT' ? null : trump;
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
  }
  return plays[bestIdx].seat;
}

/* Persistence — debounced, mirrors useDealStorage in LivePlayTab. */
function useQuickStorage(state, setState) {
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed.schemaVersion !== SCHEMA_VERSION) return;
      setState(parsed);
    } catch (_) { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
    }, 200);
    return () => clearTimeout(t);
  }, [state]);
}

export default function QuickCountTab() {
  const [deal, setDeal] = useState(initialQuickDeal);
  useQuickStorage(deal, setDeal);

  const [pickerCard, setPickerCard] = useState(null);  // {suit, rank} when picker open
  const [trumpPickerOpen, setTrumpPickerOpen] = useState(false);

  // Derived counters
  const counters = computeCounters(deal.played);

  // Current trick (in-progress) — entries from currentTrickStart onward
  const currentTrickIds = deal.trickOrder.slice(deal.currentTrickStart);
  const currentTrickPlays = currentTrickIds.map((id) => ({
    seat: deal.played[id],
    card: { rank: id[0], suit: id[1] },
  }));
  const ledSuit = currentTrickPlays.length > 0 ? currentTrickPlays[0].card.suit : null;

  // ---- Tap flow ----
  const handleCardTap = (cardObj) => {
    if (deal.played[cardId(cardObj.suit, cardObj.rank)]) return; // already played
    setPickerCard(cardObj);
  };

  const assignSeat = (seat) => {
    if (!pickerCard) return;
    const id = cardId(pickerCard.suit, pickerCard.rank);
    if (deal.played[id]) { setPickerCard(null); return; }

    const newPlayed = { ...deal.played, [id]: seat };
    const newTrickOrder = [...deal.trickOrder, id];
    let newTricks = deal.tricks;
    let newCurrentStart = deal.currentTrickStart;

    // Detect trick completion (4 cards in current trick)
    const inProgressLen = newTrickOrder.length - deal.currentTrickStart;
    if (inProgressLen === 4) {
      const plays = newTrickOrder.slice(deal.currentTrickStart).map((tid) => ({
        seat: newPlayed[tid],
        card: { rank: tid[0], suit: tid[1] },
      }));
      const winner = computeWinner(plays, deal.trump);
      const leader = plays[0].seat;
      newTricks = [...deal.tricks, { leader, plays, winner }];
      newCurrentStart = newTrickOrder.length;
    }

    setDeal({
      ...deal,
      played: newPlayed,
      trickOrder: newTrickOrder,
      tricks: newTricks,
      currentTrickStart: newCurrentStart,
    });
    setPickerCard(null);
  };

  const undoLast = () => {
    if (deal.trickOrder.length === 0) return;
    const lastId = deal.trickOrder[deal.trickOrder.length - 1];
    const newPlayed = { ...deal.played };
    delete newPlayed[lastId];
    const newTrickOrder = deal.trickOrder.slice(0, -1);

    // If we just unplayed a card that completed a trick, also unstack the trick
    let newTricks = deal.tricks;
    let newCurrentStart = deal.currentTrickStart;
    const wasTrickCompleter = deal.currentTrickStart === deal.trickOrder.length;
    if (wasTrickCompleter && deal.tricks.length > 0) {
      newTricks = deal.tricks.slice(0, -1);
      newCurrentStart = deal.currentTrickStart - 4;
    }

    setDeal({
      ...deal,
      played: newPlayed,
      trickOrder: newTrickOrder,
      tricks: newTricks,
      currentTrickStart: newCurrentStart,
    });
  };

  const resetDeal = () => {
    if (!confirm('Reset Quick Count? This clears all played cards.')) return;
    setDeal(initialQuickDeal());
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="display text-2xl mb-1">Quick Count</h2>
        <div className="text-sm" style={{ color: 'var(--muted)' }}>
          Tap a card, pick the seat that played it. No engine, no setup — just running counters and a trick log.
        </div>
      </div>

      {/* Section 1: Counters strip — sticky top */}
      <div className="sticky-strip" style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg)', paddingTop: 6, paddingBottom: 6 }}>
        <div className="grid grid-cols-4 gap-2">
          {POSITIONS.map((seat) => (
            <SeatTile key={seat} seat={seat} hcp={counters[seat].hcp} cards={counters[seat].cards} />
          ))}
        </div>
      </div>

      {/* Section 2: Current trick strip */}
      <div className="card-tile rounded-lg p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
            Current trick {ledSuit ? <>· led <span className={ledSuit === 'H' || ledSuit === 'D' ? 'red-suit' : 'blk-suit'}>{SYM[ledSuit]}</span></> : ''}
          </div>
          <div className="text-[10px] data" style={{ color: 'var(--muted)' }}>
            Trick {deal.tricks.length + 1}/13
          </div>
        </div>
        <CurrentTrickStrip plays={currentTrickPlays} />
      </div>

      {/* Section 3: Card grid — the input surface */}
      <div className="card-tile rounded-lg p-3">
        <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--muted)' }}>
          Tap a card to record who played it
        </div>
        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <CardGrid played={deal.played} onTap={handleCardTap} />
        </div>
      </div>

      {/* Section 4: Action buttons */}
      <div className="grid grid-cols-3 gap-2">
        <button
          onClick={resetDeal}
          className="rounded-lg py-3 display text-sm flex items-center justify-center gap-1.5"
          style={{ background: 'var(--burgundy)', color: 'var(--paper)', minHeight: 44 }}
        >
          <RotateCcw size={14} /> Reset
        </button>
        <button
          onClick={undoLast}
          disabled={deal.trickOrder.length === 0}
          className="pill-btn rounded-lg py-3 display text-sm flex items-center justify-center gap-1.5"
          style={{ minHeight: 44 }}
        >
          <Undo2 size={14} /> Undo
        </button>
        <button
          onClick={() => setTrumpPickerOpen(true)}
          className="pill-btn rounded-lg py-3 display text-sm flex items-center justify-center gap-1.5"
          style={{ minHeight: 44 }}
        >
          Trump: {deal.trump === 'NT' ? 'NT' : <span className={deal.trump === 'H' || deal.trump === 'D' ? 'red-suit' : 'blk-suit'}>{SYM[deal.trump]}</span>}
        </button>
      </div>

      {/* Section 5: Trick log (cross-layout) */}
      {deal.tricks.length > 0 && (
        <div className="card-tile rounded-lg p-3 space-y-2">
          <div className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
            Trick log ({deal.tricks.length} done)
          </div>
          {/* Most-recent first */}
          {[...deal.tricks].reverse().map((t, i) => {
            const trickNum = deal.tricks.length - i;
            const nsWon = t.winner === 'N' || t.winner === 'S';
            return (
              <TrickRow
                key={trickNum}
                trickNum={trickNum}
                trick={t}
                winnerColor={nsWon ? 'var(--felt)' : 'var(--burgundy)'}
                winnerAnnotation={nsWon ? 'NS won' : 'EW won'}
              />
            );
          })}
        </div>
      )}

      {/* Player picker modal */}
      {pickerCard && (
        <PlayerPicker
          card={pickerCard}
          onPick={assignSeat}
          onCancel={() => setPickerCard(null)}
        />
      )}

      {/* Trump picker modal */}
      {trumpPickerOpen && (
        <TrumpPicker
          current={deal.trump}
          onPick={(t) => { setDeal({ ...deal, trump: t }); setTrumpPickerOpen(false); }}
          onCancel={() => setTrumpPickerOpen(false)}
        />
      )}
    </div>
  );
}

/* ---- Counters: HCP + cards played per seat ---- */
function computeCounters(played) {
  const out = { N: { hcp: 0, cards: 0 }, E: { hcp: 0, cards: 0 }, S: { hcp: 0, cards: 0 }, W: { hcp: 0, cards: 0 } };
  for (const id in played) {
    const seat = played[id];
    const rank = id[0];
    out[seat].cards += 1;
    out[seat].hcp += HONORS_HCP[rank] || 0;
  }
  return out;
}

/* ---- Seat tile (counter strip) ---- */
function SeatTile({ seat, hcp, cards }) {
  return (
    <div
      className="card-tile rounded-lg flex flex-col items-center justify-center"
      style={{ borderTop: `3px solid ${PlayerColors[seat].bg}`, paddingTop: 6, paddingBottom: 6 }}
    >
      <div className="text-[10px] uppercase tracking-wider data" style={{ color: PlayerColors[seat].bg, fontWeight: 600 }}>
        {seat}
      </div>
      <div className="display text-2xl data" style={{ color: 'var(--burgundy)', fontWeight: 700, lineHeight: 1.1 }}>
        {hcp}
      </div>
      <div className="text-[10px] data" style={{ color: 'var(--muted)' }}>
        {cards} card{cards === 1 ? '' : 's'}
      </div>
    </div>
  );
}

/* ---- Current-trick strip (4 slots) ---- */
function CurrentTrickStrip({ plays }) {
  const playBySeat = {};
  for (const p of plays) playBySeat[p.seat] = p;
  return (
    <div className="grid grid-cols-4 gap-2">
      {POSITIONS.map((seat) => {
        const p = playBySeat[seat];
        const isRed = p && (p.card.suit === 'H' || p.card.suit === 'D');
        return (
          <div
            key={seat}
            className="card-tile rounded-md flex flex-col items-center justify-center"
            style={{ minHeight: 50, borderColor: p ? PlayerColors[seat].bg : 'var(--line)', borderWidth: p ? 2 : 1 }}
          >
            <div className="text-[9px] uppercase tracking-wider data" style={{ color: PlayerColors[seat].bg }}>
              {seat}
            </div>
            <div className="display text-base">
              {p ? (
                <>
                  <span className="data">{p.card.rank === 'T' ? '10' : p.card.rank}</span>
                  <span className={isRed ? 'red-suit' : 'blk-suit'} style={{ marginLeft: 1 }}>{SYM[p.card.suit]}</span>
                </>
              ) : (
                <span style={{ color: 'var(--line)' }}>?</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---- Card grid: 4 rows × 13 columns of tap targets ----
   Each cell ≥44px square. On narrow phones the grid overflows
   horizontally and the parent allows touch-scroll. */
function CardGrid({ played, onTap }) {
  return (
    <div className="space-y-1.5" style={{ minWidth: 'min-content' }}>
      {SUIT_LIST.map((suit) => (
        <div key={suit} className="flex items-center gap-1.5">
          <div
            className={`text-2xl text-center ${suit === 'H' || suit === 'D' ? 'red-suit' : 'blk-suit'}`}
            style={{ width: 28, flexShrink: 0 }}
          >
            {SYM[suit]}
          </div>
          <div className="flex gap-1">
            {RANKS_DESC.map((rank) => {
              const id = cardId(suit, rank);
              const isPlayed = !!played[id];
              const seat = played[id];
              const isRed = suit === 'H' || suit === 'D';
              return (
                <button
                  key={rank}
                  onClick={() => !isPlayed && onTap({ suit, rank })}
                  disabled={isPlayed}
                  className="card-tile rounded data flex flex-col items-center justify-center"
                  style={{
                    width: 44, height: 44, padding: 0,
                    opacity: isPlayed ? 0.25 : 1,
                    border: isPlayed ? 'none' : '1px solid var(--line)',
                    background: isPlayed ? 'transparent' : 'var(--paper)',
                    flexShrink: 0,
                  }}
                  title={isPlayed ? `played by ${seat}` : `${rank}${SYM[suit]}`}
                >
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{rank === 'T' ? '10' : rank}</span>
                  {isPlayed && (
                    <span className="text-[9px] data" style={{ color: PlayerColors[seat]?.bg, lineHeight: 1 }}>
                      {seat}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---- Player picker (centered modal) ---- */
function PlayerPicker({ card, onPick, onCancel }) {
  const isRed = card.suit === 'H' || card.suit === 'D';
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(28, 24, 20, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card-tile rounded-lg p-4"
        style={{ background: 'var(--paper)', maxWidth: 320, width: '100%' }}
      >
        <div className="text-center mb-3">
          <div className="text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--muted)' }}>
            Who played this card?
          </div>
          <div className="display text-4xl">
            <span className="data">{card.rank === 'T' ? '10' : card.rank}</span>
            <span className={isRed ? 'red-suit' : 'blk-suit'} style={{ marginLeft: 4 }}>{SYM[card.suit]}</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {POSITIONS.map((seat) => (
            <button
              key={seat}
              onClick={() => onPick(seat)}
              className="rounded-lg display"
              style={{
                background: PlayerColors[seat].bg,
                color: PlayerColors[seat].fg,
                minHeight: 64, fontSize: 22, fontWeight: 700,
              }}
            >
              {seat}
            </button>
          ))}
        </div>
        <button
          onClick={onCancel}
          className="w-full mt-3 pill-btn rounded-md py-2 text-xs"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ---- Trump picker (centered modal) ---- */
function TrumpPicker({ current, onPick, onCancel }) {
  const options = ['NT', 'S', 'H', 'D', 'C'];
  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(28, 24, 20, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card-tile rounded-lg p-4"
        style={{ background: 'var(--paper)', maxWidth: 320, width: '100%' }}
      >
        <div className="text-[10px] uppercase tracking-wider mb-3 text-center" style={{ color: 'var(--muted)' }}>
          Trump suit
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {options.map((opt) => {
            const isRed = opt === 'H' || opt === 'D';
            return (
              <button
                key={opt}
                onClick={() => onPick(opt)}
                className={`pill-btn rounded-md ${current === opt ? 'active' : ''}`}
                style={{ minHeight: 56, fontSize: 18 }}
              >
                {opt === 'NT' ? <span className="data">NT</span> : <span className={isRed ? 'red-suit' : 'blk-suit'}>{SYM[opt]}</span>}
              </button>
            );
          })}
        </div>
        <div className="text-[11px] text-center mt-3" style={{ color: 'var(--muted)' }}>
          NT = no trump (winner = highest of led suit)
        </div>
        <button
          onClick={onCancel}
          className="w-full mt-3 pill-btn rounded-md py-2 text-xs"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
