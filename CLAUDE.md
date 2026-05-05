# Bridge Companion — project briefing

A SAYC bridge companion app for use alongside Funbridge or other online bridge apps. Mobile-first PWA, single-page React. The user plays bridge, the app helps with HCP counting, bid recommendations, and card-play heuristics.

## Tech stack

- Vite 5 + React 18 + Tailwind 3
- `lucide-react` for icons (already pulled in; prefer over adding new icon libs)
- `localStorage` for state in current phases; `IndexedDB` only if Phase 3 needs blob storage
- No router yet — single-page with internal tab state
- No test framework wired in; the engine has been hand-verified via ad-hoc Node scripts

## Layout

```
src/
└── BridgeTool.jsx     Whole app: engines + UI, ~1700 lines, single export

public/
├── manifest.webmanifest
└── icon.svg
```

Yes, `BridgeTool.jsx` is large. It's intentional for now — Phase 2 will split into `engines/`, `tabs/`, `components/`, `store/`. **Don't split it preemptively** — wait until Phase 2 work creates real reuse pressure.

## Commands

- `npm run dev` — dev server on `:5173`, also exposed on LAN for phone testing
- `npm run build` — production build to `dist/`
- `npm run preview` — preview the production build locally

## Engine conventions

The bidding engine in `BridgeTool.jsx` covers SAYC: openings (1NT 15-17, 1m/1M openings, weak twos, preempts, 2♣ strong), responses to all openings, opener's first rebid (1m–1M sequences, simple/limit raises), responder's first rebid in supported sequences. Conventions on by default and engine-aware: **Jacoby Transfers** over 1NT, **Checkback Stayman / New Minor Forcing**. Both toggleable in the Conventions panel.

Conventions deliberately NOT yet engine-aware: Jacoby 2NT, Negative Doubles, Lebensohl, Michaels, Unusual 2NT, RKCB, Bergen raises, support doubles, Smolen, weak jump shifts. Adding any of these means: (a) a toggle in `ConventionsPanel`, (b) trigger detection in `analyzeAuction`, (c) handler in `recommendResponseToOpen` / `recommendResponderRebid` / `recommendOpenerRebid` as appropriate.

The opening-lead engine (`recommendOpeningLead`) is a heuristic scorer over the four suits — it is **not** a card-play AI and shouldn't pretend to be. Reasoning shown to the user is part of the value; recommendations without explanation are worse than no recommendation.

## Design system

Editorial parchment aesthetic — see the `styles` const in `BridgeTool.jsx` for the full token set. Quick reference:

- Background: `#F2EDE0` parchment, `#FBF8EE` paper surfaces
- Ink: `#1C1814` primary, `#4A4239` softer
- Accents: `#7A1F2A` burgundy (primary accent, also iOS theme tile), `#1F4D3A` forest felt (theme color, success states), `#B8924D` gold
- Fonts: Fraunces (display), Sora (body), JetBrains Mono (data)
- Suits: red `#B53A2A`, black `#1C1814`

The masthead phrase "The Defender's Eye" and the tagline "count the cards · trust the auction" are part of the brand — leave them in.

## Mobile constraints (non-obvious)

- All hover effects are wrapped in `@media (hover: hover)` to avoid stuck-hover on touch
- Tap targets are ≥40px tall; preserve this when adding new buttons
- The container is `max-w-3xl` — don't widen it; bridge is a narrow-column reading experience
- Don't add CSS `:hover` outside the gated block

## What NOT to do

- Don't add a backend. This is a pure static site; Phase 3 vision calls go straight from the browser using a user-supplied API key.
- Don't pull in `react-router`, `redux`, or other heavy deps for things React state already handles.
- Don't reformat existing engine code — the structure (`recommendOpening`, `recommendResponseToOpen`, etc.) is referenced across the codebase.
- Don't break the existing version footer convention — it's the easiest way to verify which build is deployed.

## Roadmap

- **v2.1 (current)** — Mobile polish, deployable PWA. Done.
- **v3.0 — Live trick tracker.** Spec at `docs/PHASE-2-SPEC.md`.
- **v3.5 — Knowledge layer.** Convention library editor, Argine screenshot ingest (BYO API key), correction logger.

When starting work on a new phase, read the relevant spec doc; don't guess.
