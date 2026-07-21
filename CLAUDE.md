# Navigator

Navigator is a **voice-first travel co-pilot web app for Australian road trippers — especially caravanners** (and cars, campervans, trucks). It plans the journey, finds what you need along the way (cheapest fuel, camps & caravan parks, weather, accommodation, POIs), and hands the actual driving to a real sat-nav — *"Navigator thinks, Google Maps steers."* A conversational AI receives the driver's live situation (GPS, vehicle, fuel type/range, trip plan, conditions) as context. A permanent SOS button is always visible.

**`SPEC.md` (v1.2) in the repo root is the product doctrine — read it before UI/UX work; §0 (honesty: never silently overpromise) governs every wording choice.** §13 lists the build order; the app is being restructured session-by-session toward it.

**UI shape (as of Session 1 — SPEC §10–11):** the app opens to a **home screen** — greeting · guidance (what it is, three example spoken phrases, the Drive→Stop→Brief rhythm) · a big central **mic** · a trip card when a trip is live · Solo indicator when armed. The **map is not on the home screen**: it lives behind a **results view** (`#appView`) that opens when a query returns mappable results (`showOptionPins` reveals `#mapWrap`), with an in-app "← Home" back button. **First run shows a one-time setup interview** (`#setupScreen`: name · rig · fuel · height/length · owned apps → `ownedApps` handoffs · optional solo contact), each question carrying a short "why". Returning/old profiles migrate silently and go straight home. **There is no welcome/start overlay** — it was deleted along with its popstate/pageshow/history guards (Bug 2 has nothing to resurrect). **The suggestion pegs are retired** — those are spoken requests now.

## Shape of the codebase

- **The entire app is a single file: `index.html`** (~3,400 lines, ~185 KB). It contains all markup, all CSS (one `<style>` block), and all JavaScript (one `<script>` block). There is **no build step, no framework, no bundler, no `node_modules`**. What you see in the file is exactly what ships. (`.nojekyll` at the repo root keeps GitHub Pages from running Jekyll — it must stay in every push.)
- Deployed as a static page via **GitHub Pages** at **https://csbowring6-source.github.io/Navigator2** (repo `csbowring6-source/Navigator2`, branch `main`).
- The app self-updates: on load and every 15 min it re-fetches its own URL, compares an embedded `#buildStamp` against the live copy, and shows a "tap to update" banner if stale (`checkVersion()` near the bottom of `index.html`).

## Architecture: frontend ↔ Cloudflare Worker

The frontend is fully public and holds **no secrets**. Every credentialed call goes through a **Cloudflare Worker relay**:

```
const API_URL = "https://delicate-credit-a17e.csbowring6.workers.dev/";  // index.html, ~line 685
```

The Worker holds all API keys in its own encrypted settings and proxies to the real upstreams. **The Worker's source is NOT in this repo** — only the frontend lives here. The route contract below is inferred from how `index.html` calls it.

### Worker routes used by the frontend

| Call | Route | Purpose |
|------|-------|---------|
| `POST {API_URL}` | root | AI chat. Sends an Anthropic Messages-shaped body `{model:'claude-sonnet-4-6', max_tokens:300, system, messages}`; reads back `data.content[0].text`. The Worker injects the Anthropic key. |
| `GET {API_URL}weather?lat=&lon=` | `/weather` | Weather for current position |
| `GET {API_URL}stations?lat=&lon=&radius=` | `/stations` | Fuel stations near a point |
| `GET {API_URL}fuel?lat=&lon=&type=&radius=` | `/fuel` | Live fuel prices (NSW & TAS coverage) by fuel type |
| `GET {API_URL}camps?lat=&lon=&radius=` | `/camps` | Camps / caravan parks |
| `GET {API_URL}accom?lat=&lon=&radius=` | `/accom` | Accommodation (hotels/motels/backpackers) |
| `GET {API_URL}poi?lat=&lon=&kind=&radius=` | `/poi` | Points of interest by kind |

Data routes are called with plain `fetch(...).then(r=>r.json())`, mostly wrapped in `.catch(()=>({}))` so a failed route degrades gracefully instead of breaking the app.

### Called directly from the browser (no Worker, because no key is needed)

- **Nominatim** (`nominatim.openstreetmap.org`) — geocoding / reverse geocoding
- **OSRM** (`router.project-osrm.org`) — routing, nearest-road snapping, distance tables
- **Overpass** (`overpass-api.de`) — ad-hoc OSM POI queries
- **Leaflet** (from `unpkg.com`) — map rendering; base tiles from CartoDB
- **Google Fonts** — Inter font

## THE IRON RULE: no secrets in the frontend

**No API keys, tokens, or secrets are ever hardcoded in `index.html`.** Everything secret (Anthropic, NSW/TAS fuel, weather, and any future keyed service) lives **only** behind the Cloudflare Worker. `index.html` is public and served as-is — anything placed in it is exposed to the world.

- The **only** non-keyless endpoint referenced in the frontend is the Worker URL itself, which is a public relay endpoint (not a secret).
- Any new capability that needs a key must be added as a **Worker route**, not a browser-side call with an embedded key.
- **Before any commit, scan for hardcoded secrets** (provider key formats like `sk-ant-…`, `AKIA…`, `AIza…`, bearer/auth headers, high-entropy blobs, `?key=`/`?token=` params). The frontend was verified clean as of the last review — keep it that way.

## Workflow rules (how this project is maintained)

- **The user reviews every change before it is committed.** Do not commit speculatively — show the diff / explain the change and let the user approve first.
- **The user pushes via GitHub Desktop**, not from this environment. This machine has no GitHub push credentials (HTTPS remote, no `gh` CLI, no token). Do not attempt `git push`; stage/commit only when asked, and leave publishing to the user's GitHub Desktop.
- **Test changes before committing.** Because there's no build/test harness, "test" means exercising the affected behavior in a browser — load `index.html`, drive the flow that changed (e.g. ask the AI, trigger a fuel/camps/weather lookup, check the map pins), and confirm it works and the console is clean — before proposing a commit.
- The GitHub remote for this repo is `csbowring6-source/Navigator2` (`origin`), branch `main`.

## Practical orientation for editing `index.html`

- **Screens & view switching**: `#setupScreen` (first-run interview) · `#homeScreen` (default landing) · `#appView` (results/conversation, holds the map + chat + input). `loadProfile()` decides home-vs-setup on load; `showHome()` / `openAppView()` / `backHome()` swap them; `homeMic()` opens the results view and starts listening; `revealMap()` un-hides `#mapWrap` when results land. No overlays gate any of this.
- **Vehicle profiles** (`VEHICLES`, `FUEL_TYPES`) define per-vehicle fuel range and AI "system notes" that shape advice — car / caravan / campervan / truck. (The old per-vehicle suggestion pegs are retired; `updateSuggestions()` is now a dormant no-op.)
- **Profile schema** (`navigator_profile`): `name, vehicles, rego, van, fuel, height, length, ownedApps[], soloContact{name,phone}`. Old profiles lack the last four — code defaults them; never force a returning user back through setup.
- **AI request assembly** builds a big `[Context: …]` string (fuel, economy, route, camps, accom, POI, vehicle note, drive time, solo mode, trip plan) prepended to the user's message, and trims the running `messages` array to the last 16 turns to bound payload size.
- Because everything is one file, keep edits localized and preserve the existing terse, comment-annotated style; update the `#buildStamp` when shipping a user-visible change so the self-update banner works.
