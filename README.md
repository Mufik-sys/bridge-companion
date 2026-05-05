# The Defender's Eye

A SAYC bridge companion app. Three tabs:

- **Card Counter** — track placed honors and suit lengths, watch HCP totals come together as the bidding reveals hands.
- **Auction Advisor** — full SAYC bidding engine (openings, responses, rebids, overcalls). Toggleable conventions: Jacoby Transfers + Checkback Stayman / NMF.
- **Card Play** — opening lead helper using SAYC lead rules, signal reference, defensive maxims, declarer's plan checklist.

Mobile-first PWA. Install on your phone and it opens fullscreen alongside Funbridge or any other online bridge app.

---

## Run locally

```bash
npm install
npm run dev
```

Opens at http://localhost:5173. The dev server is also exposed on your local network so you can test on your phone — visit `http://<your-laptop-ip>:5173` from the phone's browser.

For a production build:

```bash
npm run build
npm run preview
```

---

## Deploy to Render

The included `render.yaml` configures a free static-site service.

1. **Create a GitHub repo** and push this project to it:

   ```bash
   cd bridge-companion
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin git@github.com:<your-username>/bridge-companion.git
   git push -u origin main
   ```

2. **In Render**, click *New → Static Site*, connect your GitHub account if you haven't, pick this repo. Render reads `render.yaml` automatically — no manual config needed.

3. First deploy takes ~2 minutes. After that every `git push` to `main` redeploys automatically.

4. Render gives you a URL like `https://bridge-companion-XXXX.onrender.com`. That's the URL you'll open on your phone.

---

## Install on phone

Open the deployed URL in your phone's browser, then:

- **iOS Safari** — share button → *Add to Home Screen*
- **Android Chrome** — three-dot menu → *Install app* (or *Add to Home Screen*)

It then opens fullscreen with no browser chrome, just like a native app.

---

## Project layout

```
bridge-companion/
├── index.html              HTML entry, viewport, manifest, theme color
├── package.json            Dependencies and scripts
├── vite.config.js          Vite + React plugin config
├── tailwind.config.js      Content scanning paths
├── postcss.config.js       Tailwind + autoprefixer
├── render.yaml             Render static-site config
├── public/
│   ├── manifest.webmanifest    PWA manifest (Android install)
│   └── icon.svg                App icon (SVG, scales freely)
└── src/
    ├── main.jsx                React entry
    ├── index.css               Tailwind directives
    └── BridgeTool.jsx          The whole app — engines + UI (~1700 lines)
```

The whole application currently lives in a single `BridgeTool.jsx`. As Phase 2 adds the live trick tracker and Phase 3 adds the convention library, this will split into modules:

```
src/
├── engines/        SAYC bidding, lead heuristics, card-play inference
├── components/     UI primitives reusable across tabs
├── tabs/           One file per tab (Counter, Bidder, CardPlay, ...)
└── store/          Persistence layer (localStorage / IndexedDB)
```

---

## Working with Claude Code

This project includes a `CLAUDE.md` at the repo root that briefs Claude Code on the project's architecture, conventions, and constraints. When you run `claude` in this directory, it loads automatically — no setup needed.

For multi-step features there's a `docs/` folder with phase specs (currently `PHASE-2-SPEC.md`). Hand the spec to Claude Code at the start of a phase work session: `read docs/PHASE-2-SPEC.md and implement step 1`.

---

## Roadmap

- **v2.1 (current)** — Mobile UI polish, deployable PWA, hover-effect gating for touch devices.
- **v3.0 — Live trick tracker.** Spec at [`docs/PHASE-2-SPEC.md`](docs/PHASE-2-SPEC.md). Tap your 13 cards before play, then tap each card as it's played per trick. Engine maintains a constraint matrix per (player × suit): minimum/maximum length, HCP brackets from the auction, who's shown out of what. Surfaces inferences and heuristic next-card suggestions.
- **v3.5 — Knowledge layer.** Editable convention library that overrides defaults. Argine bid-meaning popup → screenshot → vision API → stored convention. Correction logger captures auctions where you and the engine disagreed, building your personal pattern library over time.

Phase 3 vision calls use a bring-your-own Anthropic API key stored locally in browser settings — no backend required.

---

## License

MIT.
