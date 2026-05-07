/* Shared UI primitives used across multiple tabs.

   Extracted from BridgeTool.jsx as part of the Phase 2 (Live Play tab) work
   so that the new tab can reuse them without a circular import. Behavior is
   intentionally identical to the original components — this is a pure move,
   not a redesign. */

import { useState } from 'react';
import { ChevronDown, ChevronUp, Undo2 } from 'lucide-react';
import {
  DENOMS, SYM, POSITIONS, POS_INDEX, PlayerColors,
  bidValue, bidLabel, lastSuitBid, isLegalBid,
} from './sharedHelpers.js';

/* Cross/diamond trick row used by both Live Play (v2.4) and Quick Count (v2.5).
   Renders the 4 cards of a completed trick in a diamond pattern, with the
   winning card highlighted with a colored 2px border and a faint glow.
   Caller supplies winnerColor (a CSS color string) and an optional
   winnerAnnotation (revealed when the user taps the row to expand it).
   Pure presentational — no engine knowledge of declarer/defender. */
export function TrickRow({ trickNum, trick, winnerColor, winnerAnnotation }) {
  const [showAnnotation, setShowAnnotation] = useState(false);
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
      <div className="data display text-[11px]" style={{ color: 'var(--muted)', minWidth: 24, textAlign: 'right' }}>
        #{trickNum}
      </div>
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
      <div className="flex-1 text-[10px] data" style={{ color: winnerColor, textAlign: 'right' }}>
        <div>{trick.winner} won</div>
        {showAnnotation && winnerAnnotation && <div style={{ color: 'var(--muted)' }}>{winnerAnnotation}</div>}
      </div>
    </button>
  );
}

/* Suit-coloured tile used by the points counter to mark which honor went where. */
export function HonorTile({ rank, suit, owner, onClick }) {
  const isRed = suit === '♥' || suit === '♦';
  const ownerStyle = owner ? { background: PlayerColors[owner].bg, color: PlayerColors[owner].fg } : { background: 'var(--paper)', color: 'var(--ink)' };
  return (
    <button
      onClick={onClick}
      className="card-tile flex flex-col items-center justify-center rounded-md py-2 px-1 text-center"
      style={{ ...ownerStyle, minHeight: 60 }}
    >
      <div className="display text-xl leading-none">{rank}</div>
      <div className={`text-base leading-tight ${owner ? '' : isRed ? 'red-suit' : 'blk-suit'}`}>{suit}</div>
      <div className="data text-[10px] uppercase tracking-wider opacity-70 mt-0.5">{owner || '—'}</div>
    </button>
  );
}

/* Auction grid — N E S W columns with leading blanks before dealer.
   Highlights the seat next to act. */
export function AuctionDisplay({ auction, dealer, onUndo }) {
  const dealerIdx = POS_INDEX[dealer];
  const cells = [];
  for (let i = 0; i < dealerIdx; i++) cells.push(null);
  for (const b of auction) cells.push(b);
  while (cells.length % 4 !== 0) cells.push(null);

  const rows = [];
  for (let i = 0; i < cells.length; i += 4) rows.push(cells.slice(i, i + 4));

  const turnIdx = (dealerIdx + auction.length) % 4;

  return (
    <div className="card-tile rounded-lg overflow-hidden">
      <div className="grid grid-cols-4 text-xs uppercase tracking-wider data" style={{ borderBottom: '1px solid var(--line)' }}>
        {POSITIONS.map((p, i) => (
          <div key={p} className="p-2 text-center" style={{
            color: i === turnIdx && auction.length < 200 ? 'var(--paper)' : 'var(--muted)',
            background: i === turnIdx && auction.length < 200 ? PlayerColors[p].bg : 'transparent',
          }}>
            {p}{p === dealer ? ' •' : ''}
          </div>
        ))}
      </div>
      <div className="p-1">
        {rows.length === 0 ? (
          <div className="p-4 text-center text-sm" style={{ color: 'var(--muted)' }}>
            Auction begins with <span className="display text-base" style={{ color: PlayerColors[dealer].bg }}>{dealer}</span>.
          </div>
        ) : (
          rows.map((row, ri) => (
            <div key={ri} className="grid grid-cols-4">
              {row.map((b, ci) => {
                const isMyBid = ci === POS_INDEX.S && b;
                return (
                  <div
                    key={ci}
                    className="p-2 text-center display text-base"
                    style={{
                      color: b ? (isMyBid ? 'var(--felt)' : 'var(--ink)') : 'var(--muted)',
                      background: ri % 2 === 0 ? 'transparent' : 'var(--paper-2)',
                    }}
                  >
                    {b ? bidLabel(b) : '·'}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
      {auction.length > 0 && onUndo && (
        <div className="px-2 py-2 flex justify-end" style={{ borderTop: '1px solid var(--line-soft)' }}>
          <button onClick={onUndo} className="pill-btn rounded-full px-3 py-1 text-xs flex items-center gap-1.5">
            <Undo2 size={12} /> Undo last
          </button>
        </div>
      )}
    </div>
  );
}

/* Bid keypad — pass / X / XX + 1♣..7NT grid, with legality enforced. */
export function BidKeypad({ auction, addBid }) {
  const tryBid = (level, denom) => {
    const b = { type: 'bid', level, denom };
    if (isLegalBid(b, auction)) addBid(b);
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => addBid({ type: 'pass' })} className="pill-btn rounded-md px-4 py-2 text-sm flex-1 min-w-[80px]">Pass</button>
        <button
          onClick={() => isLegalBid({ type: 'dbl' }, auction) && addBid({ type: 'dbl' })}
          disabled={!isLegalBid({ type: 'dbl' }, auction)}
          className="chip-btn rounded-md px-4 py-2 text-sm flex-1 min-w-[80px]"
          style={{ color: 'var(--burgundy)' }}
        >X (Dbl)</button>
        <button
          onClick={() => isLegalBid({ type: 'rdbl' }, auction) && addBid({ type: 'rdbl' })}
          disabled={!isLegalBid({ type: 'rdbl' }, auction)}
          className="chip-btn rounded-md px-4 py-2 text-sm flex-1 min-w-[80px]"
          style={{ color: 'var(--felt)' }}
        >XX</button>
      </div>
      <div className="grid grid-cols-5 gap-1">
        {[1, 2, 3, 4, 5, 6, 7].map((lvl) =>
          DENOMS.map((d) => {
            const b = { type: 'bid', level: lvl, denom: d };
            const ok = isLegalBid(b, auction);
            const red = d === 'H' || d === 'D';
            return (
              <button
                key={`${lvl}${d}`}
                onClick={() => tryBid(lvl, d)}
                disabled={!ok}
                className="chip-btn rounded-md py-2.5 text-sm data"
              >
                <span>{lvl}</span>
                <span className={red ? 'red-suit' : 'blk-suit'} style={{ marginLeft: 1 }}>{SYM[d]}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/* Toggle switch with label — used in conventions panel + setup checkboxes. */
export function Toggle({ checked, onChange, label }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className="flex items-center justify-between w-full py-2 px-3 text-left rounded card-tile"
      style={{ borderColor: checked ? 'var(--felt)' : 'var(--line)' }}
    >
      <span className="text-sm">{label}</span>
      <span
        className="relative inline-block"
        style={{
          width: 36, height: 20, borderRadius: 999,
          background: checked ? 'var(--felt)' : 'var(--line)',
          transition: 'background 120ms ease',
        }}
      >
        <span
          className="absolute"
          style={{
            top: 2, left: checked ? 18 : 2,
            width: 16, height: 16, borderRadius: 999,
            background: 'var(--paper)',
            transition: 'left 120ms ease',
            boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
          }}
        />
      </span>
    </button>
  );
}

/* Collapsible section — used for reference panels. */
export function Collapsible({ title, icon, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card-tile rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-3 text-left"
      >
        <div className="flex items-center gap-2">
          {icon}
          <span className="display text-base">{title}</span>
        </div>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1" style={{ borderTop: '1px solid var(--line-soft)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

/* Single-suit text input (e.g. "AKQ72"). Used in the lead helper + Live Play setup. */
export function SuitInput({ suit, value, onChange, placeholder }) {
  const isRed = suit === 'H' || suit === 'D';
  return (
    <div className="flex items-center gap-2">
      <span className={`text-xl w-6 text-center ${isRed ? 'red-suit' : 'blk-suit'}`}>{SYM[suit]}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder || 'e.g. AKQ72 or T9 or —'}
        className="flex-1 card-tile rounded px-3 py-2 text-base data bg-transparent outline-none"
      />
    </div>
  );
}

/* Level + strain pickers for the final contract. */
export function ContractPicker({ contract, setContract }) {
  return (
    <div className="space-y-2">
      <div>
        <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--muted)' }}>Level</div>
        <div className="flex gap-1">
          {[1, 2, 3, 4, 5, 6, 7].map((lvl) => (
            <button
              key={lvl}
              onClick={() => setContract({ ...contract, level: lvl })}
              className={`pill-btn rounded-md flex-1 py-2.5 data text-sm ${contract.level === lvl ? 'active' : ''}`}
            >{lvl}</button>
          ))}
        </div>
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--muted)' }}>Strain</div>
        <div className="flex gap-1">
          {DENOMS.map((d) => {
            const red = d === 'H' || d === 'D';
            const isActive = contract.denom === d;
            // When active, the button has a dark background — the suit symbol must
            // override its red-suit/blk-suit class color so it stays readable.
            const symStyle = isActive ? { color: 'var(--paper)' } : undefined;
            return (
              <button
                key={d}
                onClick={() => setContract({ ...contract, denom: d })}
                className={`pill-btn rounded-md flex-1 py-2.5 ${isActive ? 'active' : ''}`}
              >
                <span className={red ? 'red-suit' : 'blk-suit'} style={symStyle}>{SYM[d]}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
