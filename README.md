# Smuggled Phrases

> Nothing to declare. Plenty to say.

An in-person party game, as an installable PWA. Every phone privately holds a hand of silly
phrases. Work one into the real conversation without anyone noticing and you have smuggled it.
The app only manages hands, timers and scoring; all of the play happens out loud.

## How to play

1. Everyone starts with **5 secret phrases**.
2. Say a phrase out loud in conversation, then tap **I said it** on that card. A private 30-second countdown starts.
3. If nobody calls it in 30 seconds, shout **"Smuggled!"**, show the card and stamp it out of your hand.
4. To catch someone, shout **"Contraband!"** inside the 30 seconds **and repeat the phrase**. Pointing at a person is not enough.
5. Caught: the phrase is seized and replaced. The catcher may swap one of their own phrases for a new one.
6. Wrong call: the caller draws an extra phrase and loses one of their 3 inspector badges. No badges, no calling. Bluffing with odd sentences to drain badges is allowed.
7. First player with an empty hand wins.
8. Phrases must be spoken aloud. Close paraphrases of long phrases count.

## Two ways to play

**Offline (no network at all).** One player makes a 4-letter code; everyone types it in and picks a
unique player number (1-10). Each phone shuffles the same deck with a PRNG seeded from the code and
takes only its own stripe of it, so no two phones ever hold the same phrase and replacement draws
never collide. Scoring is on the honor system. A 3-digit "manifest check" number lets the table
confirm everyone typed the same code and picked the same packs.

**Synced rooms (online).** The host opens a room; others join by code, link or QR. The server owns
the deck and every draw. You get a live scoreboard, a **Contraband!** button that names the accused
(who confirms which phrase was caught, or denies), automatic bust / swap / wrong-call handling, and
a win announcement on every phone with the winner's smuggled phrases revealed. The accused's clock
stops while a call is being settled.

In both modes the game survives a locked phone or a reload: timers are stored as start timestamps,
state is persisted locally, and synced phones reconnect on their own.

## Stack

| Part | Choice |
| --- | --- |
| App | Vite, TypeScript, Preact; fonts bundled, no runtime network dependencies |
| PWA | Web app manifest plus a small hand-written service worker that precaches every built file |
| Rules | Pure TypeScript module shared by the app and the server |
| Realtime | One Cloudflare Worker; one Durable Object per room, hibernating WebSockets |
| Tests | Vitest |

```
src/
  packs/            phrase decks (JSON)            <- core.json is the 300+ phrase deck
  shared/           pure game logic, no DOM, no network
    rules.ts        the rules engine (reducer: game + action -> game + events)
    deal.ts         seeded shuffle and per-player stripes for offline mode
    prng.ts         hash, mulberry32, shuffle, game codes
    packs.ts        pack registry and deck building
    room.ts         synced room logic: members, host, messages -> rules actions, per-player views
    protocol.ts     WebSocket message types
  client/           the PWA
    session.ts      OfflineSession (local engine) and SyncSession (socket, reconnects)
    hand.tsx        hand, countdowns, cover, call / swap / accused flows
    screens.tsx     start, setup, lobby, scoreboard, win, how-to
    sw.js           service worker template (file list injected at build)
worker/index.ts     Worker entry and the RoomObject Durable Object
tests/              rules, seeded deal, packs, room logic
```

## Local development

Requires Node 20+.

```sh
npm install
npm test            # rules engine, seeded deal, packs, room logic
npm run dev         # app on http://localhost:5173 (offline mode works on its own)
npm run dev:worker  # in a second terminal: rooms on :8787, proxied from /api by Vite
```

To try the real thing, service worker included, on one port:

```sh
npm run preview     # builds, then serves app + rooms from the local Worker on :8787
```

The service worker is only registered in production builds, so `npm run dev` never serves stale
files. To test on phones over your LAN, note that installing a PWA and service workers need HTTPS
(or localhost); a tunnel such as `cloudflared tunnel --url http://localhost:8787` is the easy way.

## Deployment

Everything deploys as a single Cloudflare Worker: static assets plus the room Durable Object.
It runs on the Workers free plan (the Durable Object uses the SQLite storage backend).

```sh
npx wrangler login
npm run deploy      # vite build, then wrangler deploy
```

`wrangler.jsonc` holds the config: assets from `dist/`, the `ROOMS` Durable Object binding and its
migration. Add a `routes` entry or a custom domain in the Cloudflare dashboard if you want one.

If you host the static app somewhere else, build with `VITE_API_BASE=https://your-worker.example`
so the app knows where the rooms live. Offline mode needs no backend at all: any static host works.

## Adding phrase packs

A pack is a JSON file in `src/packs/`:

```json
{
  "id": "after-dark",
  "name": "After Dark",
  "description": "Not for the family table.",
  "rating": "adult",
  "version": 1,
  "phrases": ["...", "..."]
}
```

Register it in `PACKS` in `src/shared/packs.ts` and it appears in the host's pack picker in both
modes (`"rating": "adult"` is labelled 18+). Bump `version` whenever you edit a pack, so offline
shuffles never mix old and new contents. `buildDeck()` also accepts unregistered packs, which is
the hook for user-made custom packs later. The pack tests check for duplicates across packs.

## Good to know

- **Vibration** fires when a countdown completes where the browser supports it (Android). iOS Safari
  has no vibration API, so there the card turns green instead. The screen is kept awake while a
  countdown runs (where Wake Lock is supported); if the phone was locked anyway, the buzz comes
  when you unlock it.
- **Offline mode** supports up to 10 players and gives each about 30 phrases. Player numbers must
  be unique; the app cannot check that without a network.
- **Synced rooms** hold up to 12 players and close after 6 hours without activity. Players are a
  display name plus a random per-device id; there are no accounts. Late arrivals are dealt in.
  The host can void a stuck call or remove a player whose phone has gone away, and if the host
  leaves, the next player becomes host.
- **Regenerating icons**: edit `public/icons/icon.svg`, then `npm run icons` (needs Playwright).
