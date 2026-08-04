# Navigator

Navigator is a **voice-first travel co-pilot web app for Australian road trippers — especially caravanners** (and cars, campervans, trucks). It plans the journey, finds what you need along the way (cheapest fuel, camps & caravan parks, weather, accommodation, POIs), and hands the actual driving to a real sat-nav — *"Navigator thinks, Google Maps steers."* A conversational AI receives the driver's live situation (GPS, vehicle, fuel type/range, trip plan, conditions) as context. A permanent SOS button is always visible.

**`SPEC.md` (v1.2) in the repo root is the product doctrine — read it before UI/UX work; §0 (honesty: never silently overpromise) governs every wording choice.**

**UI shape:** opens to a **home screen** — greeting · guidance · a big central **mic** · a trip card when a trip is live · Solo indicator when armed. The **map is not on the home screen**: it lives behind a **results view** (`#appView`) that opens when a query returns mappable results. **First run shows a one-time setup interview** (`#setupScreen`: name · rig · fuel · height/length · owned apps → `ownedApps` handoffs · optional solo contact); returning/old profiles migrate silently and go straight home. **No welcome/start overlay.** The suggestion pegs are retired — those are spoken requests now.

## Three maintained files & the voice boundary

- **`index.html`** — all markup, all CSS (one `<style>`), all app JS (one inline `<script>`). Ships to GitHub Pages.
- **`speech.js`** — the voice subsystem ONLY (conversation session, cloud + Web-Speech capture, the mic state machine, cues, TTS + suppression tail, the no-progress/oscillation ceilings, the event ring buffer). Loaded as a **classic** script *before* the inline app script (`<script src="speech.js?v=STAMP">`), so the two share one global scope. Ships to GitHub Pages.
- **`worker-camps.js`** — the Cloudflare Worker relay source. **It IS in this repo** (tracked). It does NOT ship to Pages — it deploys separately via `wrangler deploy`.

**No build step, no framework, no bundler, no `node_modules`** — what you see in the files is exactly what ships. `.nojekyll` at the repo root keeps GitHub Pages from running Jekyll — it must stay in every push.

**The voice boundary is strict.** Nothing outside `speech.js` may touch voice internals. `index.html` reaches voice ONLY through the global **`Voice`** API:
`openSession()` · `closeSession(reason)` · `toggleCapture()` · `micTap()` · `reset()` · `speak(text)` · `queueReplies(on)` · `cancelSpeech()` · `unlockAudio()` · `state()` · `isSessionOpen()` · `isCapturing()` · `canHandsFree()` · `onTranscript(cb)` · `setBusyGetter(fn)` · `takeTurnEnd()` · `log(kind,detail)` · `getLog()` · `clearLog()` · `BUILD`.
The two app couplings are **injected** at INIT — `Voice.onTranscript(sendMessage)` and `Voice.setBusyGetter(() => busy)` — so the module never reads app state. The module still *calls* a few app globals by name (`addMsg`, `setPending`, `pendingQuestion`, `pendingIsFresh`, `cleanTranscript`, `autoResize`, `API_URL`, `lastSpoken`); a thin global `speak()` shim in `index.html` delegates to `Voice.speak`.

## Versioning & the deploy split

- **Frontend triad — bump together on every frontend ship:** the `?v=` on the `speech.js` tag, `Voice.BUILD` (in speech.js), and `#buildStamp` (in index.html) all carry the same stamp. INIT compares `Voice.BUILD` to `#buildStamp` and shows the update banner on mismatch, so a stale cached module can't hide. The app also self-updates: on load and every 15 min it re-fetches its own URL and shows a "tap to update" banner if `#buildStamp` is stale (`checkVersion()`).
- **Worker stamp — separate:** `WORKER_BUILD` in worker-camps.js, returned by `/version`. Bump it on any Worker change.
- **Deploy split:** a **GitHub Desktop push** (branch `main`, repo `csbowring6-source/Navigator2`) ships the frontend to GitHub Pages at **https://csbowring6-source.github.io/Navigator2**. A **`wrangler deploy`** ships the Worker. A frontend-only change needs no wrangler deploy; a Worker change needs one and takes effect only after redeploy (and cached KV entries refresh). **State explicitly in every report whether worker-camps.js changed.**
- The on-phone **voice-log view** (long-press the mic) shows the event ring buffer + both stamps.

## Architecture: frontend ↔ Cloudflare Worker

The frontend is fully public and holds **no secrets**. Every credentialed call goes through the Worker, which holds all keys in its encrypted settings.

```
const API_URL = "https://delicate-credit-a17e.csbowring6.workers.dev/";  // index.html ~line 815
```

Worker `fetch(request, env)` dispatches by exact pathname (wrapped in try/catch → 503), with an AI-chat fallthrough at root. KV binding `env.PLACES_KV`; secrets in `env` (`GOOGLE_PLACES_KEY`, Anthropic, NSW/TAS fuel, weather).

| Route | Method | Purpose | Cache / TTL |
|---|---|---|---|
| `/` (root) | POST | AI chat — Anthropic Messages body `{model:'claude-sonnet-4-6', max_tokens:300, system, messages}`; reads `data.content[0].text`. Has an 8s AbortController timeout on the frontend. | — |
| `/weather` | GET | Weather for a position | — |
| `/stations` | GET | Nearby fuel stations (OSM proximity, all brands) | — |
| `/fuel` | GET | Live fuel prices by type (NSW & TAS) | — |
| `/camps` | GET | OSM camps/caravan parks (Overpass) — **phase-3 merge fallback; do not remove** | `camps:` 7-day, stale-serve on Overpass error |
| `/camps2` | GET | Places-backed camps (Google Places searchText, exact field mask) — **phase 1** | `camps2:` 30-day |
| `/camps2-osm` | GET | Filtered OSM **non-commercial** camps / rest areas — **phase 2** | `camps2-osm:` 7-day |
| `/accom` | GET | Accommodation (hotels/motels/backpackers) | — |
| `/poi` | GET | POIs by kind | — |
| `/transcribe` | POST | Cloud speech-to-text for the cloud-ears capture path | — |
| `/place-phone` | GET | One site's phone by OSM/Places id — **do not remove** | `place-phone:` 90-day (found) / 7-day (miss) |
| `/geocode` | GET | Nominatim geocode via the Worker (proper UA + retry) | 30-day |
| `/reverse-geocode` | GET | Nominatim reverse-geocode via the Worker | 7-day |
| `/places-probe` | GET | TEMPORARY diagnostic — remove at phase 4 | — |
| `/log` · `/log/<id>` | POST · GET | Share a voice log: POST stores text under a short id, returns `{id}`; GET retrieves | `log:` 7-day |
| `/version` | GET | Returns `WORKER_BUILD` | — |

The shared `overpass(q)` helper (four mirrors, retry/backoff, 30-min in-memory cache) backs `/camps`, `/camps2-osm`, `/poi`, `/accom`, `/stations`. Data routes are called `fetch(...).then(r=>r.json())`, mostly `.catch(()=>({}))` so a failed route degrades gracefully.

**Called directly from the browser (no key needed):** Nominatim (fallback), OSRM (routing/snap/distance tables), Overpass (ad-hoc POI), Leaflet + CartoDB tiles (map), Google Fonts (Inter).

## THE IRON RULE: no secrets in the shipped frontend

**No API keys/tokens/secrets are ever hardcoded in `index.html` or `speech.js`.** Both are public and served as-is. Everything secret lives only behind the Worker; any new keyed capability is a **Worker route**, never a browser-side call with an embedded key. **Before any commit, scan both frontend files for hardcoded secrets** (`sk-ant-…`, `AKIA…`, `AIza…`, bearer/auth headers, `?key=`/`?token=`). The only non-keyless endpoint in the frontend is the public Worker URL itself.

## Places camps architecture (phases ①–④)

The approved 26 Jul plan, additive and field-proven stage by stage:
- **① `/camps2`** — Places (commercial). **LIVE.**
- **② `/camps2-osm`** — OSM non-commercial (free camps, bush camps, rest areas); tag- + name-based classifier excludes commercial-named sites. **LIVE.**
- **③ Frontend merge** — `fetchMergedCamps` fetches `/camps2` + `/camps2-osm` for the anchor, dedupes (Places wins within ~100 m + shared name token), orders by drive time, appends a **"plus free camps"** group when the top-3 are all commercial. Numbers render **on every card** (tap to call). Fallback: `/camps2` down → old `/camps`; `/camps2-osm` down → Places-only + an honest "couldn't check free camps" line. **LIVE.**
- **④ Retirement — NOT DONE.** Do **not** remove `/camps`, `/place-phone`, or `/places-probe` yet — the phase-3 fallback and the on-request number lookup still depend on them.

**Data-coverage limit (free status):** a genuinely-free site that exists ONLY in Places under a commercial name (e.g. "Cowley Beach Caravan Park") with no OSM non-commercial twin has NO fee signal in any feed — it renders brown-with-call honestly; do NOT guess it green. (Free-by-nature is carried from an OSM twin via `freeByNature` when a dedupe drops it; a Places-only record has no such twin.)

## Key subsystems

- **Gazetteer + phonetic rescue** (`AU_TOWNS`, ~2968 towns bundled offline, from GeoNames, **CC-BY 4.0**, floor lowered to ~200-pop populated places). *(The array's own header comment still says pop≥1000/~1,013 — stale; trust the count.)* Mishears are rescued phonetically (`phonKey` consonant-skeleton keys, precomputed). **Rejection loop** (`escalateAfterRejection`): on a rejected candidate, don't re-run the same strategy — geocode the raw transcript WITH the said state if not already tried, widen the phonetic search, offer up to three NEW candidates (never re-offer rejected ones), and if nothing new, honestly say it can't place the town and suggest typing it.
- **Day/overnight classify spike** (`classifyTripMode`) — a cheap `claude-haiku-4-5` call with `output_config` `json_schema` → `{mode: day|journey|mixed|none}`, a hard **2s** AbortController timeout, `outcome: ok|timeout|network|invalid`. It **never throws** and logs via `Voice.log`. `classifyTripModeOrGate` uses it first and **falls back to the deterministic `tripModeVote` gate** on any failure — the gates remain the offline fallback and the source of truth when the AI is unreachable.

## Wording & honesty conventions (locked — do not drift)

Match these exactly; treat drift as a regression.
1. **Durations** — always hours-and-minutes (`"1 hr 35"`, `hrsMins`/`hrsMinsSpoken`). Never total minutes (`"95 minutes"`), never decimal hours.
2. **Stop-sync rhythm line** — exactly **"when you pull in, I'll size up the next stretch."** Descriptive, not directive.
3. **Sat-nav handoff** — names the driver's own preferred sat-nav (Google/Apple Maps or Waze, per setup). Never hardcode "Google Maps."
4. **Honest failure** — OUR lookup failing is stated as ours (*"couldn't find a number for X"*, *"couldn't check free camps just now"*), **never dressed as a fact about the world** (*never* "the park has no number"). SPEC §0.
5. **Numbers on the card by default** — every park card shows a tap-to-call number under its directions control, on by default, never on request.
6. **Free camps are normal, not a failure** — a PLAIN free camp / rest area gets **NO note** (the green + FREE tag says it; field 4 Aug: a floating grey note read as a banner for the card below). Only EXCEPTIONAL notes render, and INSIDE the card's coloured boundary (`has-note` frame): pub/showground → "check at the bar/office"; a commercial no-number → the honest miss line. **Never the missing-number apology for a free site**, and **no text renders between cards, ever**.

## How we work (ticket discipline)

- **Conflict-check preamble.** Most tickets open with: check the current code for what this conflicts with / duplicates / supersedes; if there's a conflict, **report it and stop** — do not work around it.
- **Report-first for investigations.** Field-bug tickets ask for a trace/diagnosis before any code change; report the exact cause, then fix.
- **Relevant suites only.** Run only the test suites relevant to the change unless told to run the full sweep.
- **Bench replay for field logs.** A shared field log (id like `4D6EDK9`) becomes a permanent bench replay case reproducing the sequence.
- **One behaviour per ticket.** Never ship "part 1"; if too big, split *before* starting.
- **Bench-test before commit — "tested" means executed.** Core logic is exercised as pure functions with fake inputs (extract-and-`geval` pattern, mocked globals); put the output in the report. Worker logic is benched the same way.
- **Regression-check every commit** — the **mic capture path**, the **home render**, and the **setup interview** stay working (mic capture has regressed before).
- **The user reviews every change before commit; the user pushes via GitHub Desktop** (this machine has no push creds — never `git push`).
- **Bump /version and end every report with the stamp(s)** — frontend `DEPLOYED: ✓ v <DD Mon YYYY, HH:MM AM/PM AEST>` and, if the Worker changed, the `WORKER_BUILD` line + a wrangler-deploy note. Get the time from `TZ="Australia/Sydney" date`, never guess.

## Benches

- **`voice_bench.mjs`** (repo root, tracked) loads the real `speech.js` under mocked browser globals, drives the state machine (normal turn · early-onend loop · ambient finalisation · TTS overlap · compose-gap · the four close paths · the bar label), asserts the invariants, and replays pasted field logs. Run: `node voice_bench.mjs`.
- Other benches (camps merge/anchor/routing, phone-miss, hands-free tip, worker camps2 / camps2-osm) live in the session scratchpad, not the repo — they `geval` functions extracted from `index.html`/`worker-camps.js`. Recreate with the same pattern.
- **Known-stale — do NOT chase in sweeps:** `convo_fixb_test`, `oscillation_test`, `recovery_test`, `timeout_test`. These four fail on drifted extraction regexes / moved symbols against the evolved frontend; they are not regressions and are excluded from the "all green" bar.

## Practical orientation for editing `index.html`

- **Screens & view switching**: `#setupScreen` (first-run) · `#homeScreen` (landing) · `#appView` (results/conversation + map + chat + input). `loadProfile()` decides home-vs-setup; `showHome()` / `openAppView()` / `backHome()` swap them; `homeMic()` opens results and starts listening; `revealMap()` un-hides `#mapWrap`. No overlays gate any of this.
- **Vehicle profiles** (`VEHICLES`, `FUEL_TYPES`) define per-vehicle fuel range + AI "system notes" (car / caravan / campervan / truck). `updateSuggestions()` is a dormant no-op (pegs retired).
- **Profile schema** (`navigator_profile`): `name, vehicles, rego, van, fuel, height, length, ownedApps[], soloContact{name,phone}`, plus `everUsedHandsFree`. Old profiles lack later fields — code defaults them; never force a returning user back through setup.
- **Camps routing**: `answerCamps → loadTripCampRound → campsAnchor` (destination-anchored, with persistence-recovery of `committedDest`) → `getCampsNear` / `getCorridorCamps` → `fetchMergedCamps` → `formatCampsAnswer` + card render. A committed trip anchors camps on the **destination**, not GPS.
- **AI request assembly** builds a big `[Context: …]` string (fuel, economy, route, camps, accom, POI, vehicle note, drive time, solo mode, trip plan) prepended to the user's message, and trims `messages` to the last 16 turns.
- Everything is one file — keep edits localized, preserve the terse comment-annotated style, and bump the frontend triad on any user-visible change.
