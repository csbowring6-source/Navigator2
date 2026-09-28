# INVENTORY REPORT: what carries into the Navigator rebuild

*Report ticket. No code changed. The only file added is this report. worker-camps.js is unchanged and nothing was deployed.*
Written 28 Sep 2026, 10:02 AM AEST.

**Conflict check:** `main` had a clean working tree and was up to date with `origin/main` after a fetch (HEAD `b0a9f54 GREETING-VOICE`). There were no uncommitted changes and no unpushed commits.

**The rebuild's two jobs:**
- **Somewhere to stay:** three van-suitable parks (free camps included), with a phone number, one-tap call, ring the next one if full, then hand over to the driver's map app.
- **Fuel warning:** given the range left, the next servo, whether it is open, whether it sells diesel, and the distance to the servo after it.

---

## 1. Repo map

### Tracked files

| File | Size (bytes) | Lines | What it is |
|---|---:|---:|---|
| `index.html` | 547,718 | 6,665 | The whole app: markup, one `<style>`, one inline `<script>` |
| `voice_bench.mjs` | 133,381 | 1,621 | Node bench for `speech.js` (plus a few regex checks against `index.html`) |
| `speech.js` | 111,495 | 1,844 | Voice subsystem (session, capture, mic state machine, TTS, event log) |
| `worker-camps.js` | 47,457 | 868 | Cloudflare Worker (all keyed calls) |
| `CLAUDE.md` | 16,010 | — | Project guide |
| `SPEC.md` | 8,602 | — | Product doctrine v1.2 |
| `CONVERSATION-MODE-REPORT.md` | 5,017 | — | Old report |
| `DESTINATION-RESOLUTION-REPORT.md` | 3,627 | — | Old report |
| `TODO.md` | 2,076 | — | Notes |
| `.gitignore` | 51 | — | Ignores `.DS_Store`, `worker-camps.js`, `wrangler.toml`, `.wrangler/` |
| `.nojekyll` | 1 | — | Keeps GitHub Pages from running Jekyll |

**Untracked, on disk only:** `wrangler.toml` (826 B: Worker name, compat date, `PLACES_KV` binding), `.claude/settings.local.json` (464 B), `.wrangler/` (cache), `.DS_Store`.

Two oddities:
- `.gitignore` lists `worker-camps.js`, but the file is tracked (it was added before the ignore rule), so edits to it still show up in git.
- There are no test suites in the repo other than `voice_bench.mjs`. The camps, fuel and worker benches lived in old session scratchpads and are gone.

### index.html: main sections

| Lines | Section |
|---|---|
| 1–373 | `<head>` and the single `<style>` block |
| 378–599 | `#setupScreen`: the first-run interview (name, rig, fuel, height/length, owned map apps, solo contact) |
| 600–627 | `#homeScreen`: greeting, big mic, trip card, build stamp |
| 628–851 | `#appView`: `#mapWrap` / `#map` (Leaflet), chat area, input bar, plus the bottom sheets and modals: `vehicleSheet`, `fuelSheet`, `rangeSheet`, `condSheet`, `locSheet`, `mapSheet`, `fillSheet`, `fuelLogSheet`, `tripSetupModal`, `mapPrefModal`, `voiceLogModal`, SOS |
| 852 | `<script src="speech.js?v=…">` |
| 853–6663 | The app script. The large blocks inside it are listed below. |

Large non-function blocks inside the script:
- **~870–930 `VEHICLES` / `FUEL_TYPES`:** per-rig search distance in km (car 50, caravan 300, campervan 200, truck 400; this is the query distance, not the fuel-tank range) plus AI "system notes".
- **Line 1127 `AU_TOWNS`:** one line of **132,925 characters**, about 24% of the file. It holds roughly 2,968 towns `[name, lat, lon, state, phonKey]` from GeoNames, licensed CC-BY 4.0.
- **~3093–3150 `SYSTEM`:** the AI system prompt.

### index.html: functions by job (267 named functions; line numbers shown)

**Voice / mic (app side; the voice internals are in `speech.js`)**
`cleanTranscript` 1410 · `handsFreeTipDueNow` 1622 · `homeMic` 1677 · `matchMapCommand` 1710 · `isMapMention` 1727 · `autoResize` 2925 · `handleKey` 2926 · `suggest` 2929 · `isCampsMishear` 3979 · `setPending` 4014 · `pendingIsFresh` 4015 · `isTopicChange` 4022 · `reaskPending` 4032 · `pendingMissAction` 4058 · `matchPendingAnswer` 4175 (~200 lines) · `sendOrCancel` 5681 · `sendMessage` 5695 · `_sendMessageInner` 5711 (~750 lines: the intent router and AI request assembly) · `speak` 6549 (shim to `Voice.speak`) · `bootGreeting` 6652

**Trip and route**
- *Destination resolve / commit:* `commitDestination` 960 · `loadCommittedDest` 967 · `committedCoordsFor` 973 · `ensureCommittedDest` 983 · `tripScaleFraming` 992 · `adoptTrip` 997 · `adoptTripAt` 1039 · `editDistance` 1045 · `resolveDestination` 1095
- *Gazetteer / phonetic rescue:* `phonKey` 1131 · `phonSubseq` 1140 · `matchTowns` 1142 · `collapseNearbyDuplicates` 1161 · `decideOffer` 1184 · `driverState` 1197 · `splitTownState` 1199 · `respondToUnresolved` 1209 · `escalateAfterRejection` 1234 · `geocodeLocal` 1244
- *Trip mode / intent:* `proceedAfterTrip` 1255 · `finishTripMode` 1277 · `classifyTripMode` 1320 · `classifyTripModeOrGate` 1363 · `resolveTripModeFromUtterance` 1385 · `asksForDestination` 1416 · `looksLikeBarePlace` 1425 · `leadingPlace` 1447 · `normaliseDest` 1465 · `extractDestCandidates` 1472 · `formatDayBrief` 1500 · `parseTripIntent` 1521 · `destSuspect` 1599 · `tripModeVote` 4071 · `savedTripDest` 4119 · `needsStaleTripConfirm` 4125 · `clearLeftoverTrip` 4131 · `sameTownName` 4150 · `confirmAnswerTrip` 4161
- *Trip UI / saved trips:* `renderHomeTripCard` 1818 · `currentRunDestSaved` 1938 · `openTripSetup` 2009 · `skipTripSetup` 2014 · `toggleTripChip` 2018 · `selectOneChip` 2022 · `saveTripSetup` 2029 · `clearThisTrip` 2080 · `startCompletelyFresh` 2100 · `resumeTrip` 2109 · `saveStopForRun` 2152 · `renderSavedTrips` 2163 · `deleteRun` 2180 · `recallTrip` 2191
- *Route computation:* `drawCommittedRoute` 2378 · `plotTripRoute` 2388 · `tripNow` 2446 · `tripHeaderLine` 2465 · `buildRouteCtx` 2470 · `distTime` 3160 · `checkRoadSnap` 3173 · `offRoadNote` 3202 · `roadDistances` 3208 · `distToRoute` 3233 · `progressAlongRoute` 3244 · `distKm` 3520

**Geocode / location**
`geoFetch` 1066 · `revGeoFetch` 1081 · `initGPS` 2538 · `updateGps` 2587 · `openLocSheet` 2590 · `closeLocSheet` 2594 · `setManualLocation` 2599 · `loadManualLocation` 2622 · `geocodePlace` 3727

**Camps**
- *Fetch / select / merge:* `selectCorridorCamps` 3532 · `dedupeCampSites` 3589 · `sharesNameToken` 3627 · `fetchMergedCamps` 3635 · `isFreeNature` 3694 · `isFreeGroupEligible` 3695 · `pickFreeCampGroup` 3700 · `getCorridorCamps` 3706 · `getCampsNear` 3737
- *Answer / format:* `timePhrase` 3851 · `campAmenities` 3859 · `formatCampsAnswer` 3871 · `campCardNote` 3947 · `campFilterFromText` 4374 · `campHeaderText` 4381
- *Intent:* `isCampsQuery` 3969 · `isCampsAnaphora` 3991 · `isTripCampsAnaphora` 4000 · `campsAnchor` 4942 · `campsEstMins` 4966 · `askCampsAnchor` 4967 · `loadTripCampRound` 4979 · `answerCamps` 5148 · `fetchCamps` 5167 (the legacy AI-context path)
- *Round persistence / resume:* `saveCampRound` 4394 · `loadCampRound` 4400 · `clearCampRound` 4411 · `tripRoundMatch` 4419 · `resumeMode` 4427 · `resumeCampRoundIfPersisted` 4435 · `startCampRound` 4483 · `campSite` 4497 · `widenCampSearch` 4633
- *Cards:* `buildCampCard` 5015 · `renderCampCards` 5060 · `renderRoundCards` 5082 · `renderCampFilterChips` 5102 · `applyCampFilter` 5118 · `scrollFirstCardIntoView` 5137 · `campAnchorCluster` 1784 · `frameCampRound` 1795

**Phone lookup and call (including the ring-around)**
`verifiedPhone` 3804 · `phoneMiss` 3816 · `localPhone` 3826 · `nextUntriedCallable` 4498 · `currentRingSite` 4500 · `noteCampCalled` 4508 · `lastNavBubble` 4515 · `scrollControlIntoView` 4521 · `roundCallButton` 4531 · `promptCallOutcome` 4541 · `campOutcome` 4575 · `handleRingAroundVoice` 4646 · `handleNavigateBooked` 4666 · `extractNumberRequest` 4696 · `ordinalIndex` 4715 · `isClosestAsk` 4731 · `matchListedSite` 4743 · `askWhichSite` 4758 · `presentNumber` 4775 · `denyNumber` 4790 · `getNumberFor` 4800 · `getNumbersForAll` 4809 · `handleNumberRequest` 4827 · `checkCampReturn` 4920

**Fuel**
`fuelChipText` 871 · `setFuelType` 2877 · `chooseFuel` 2884 · `closeFuelSheet` 2889 · `setRange` 2895 · `chooseRange` 2896 · `closeRangeSheet` 2900 · `freshPrices` 3257 · `servoUnderfoot` 3271 · `servosNearby` 3288 · `nearbyServoNote` 3315 · `fetchFuelPrices` 3324 · `fetchStations` 5187 · *logbook:* `getFuelLog` 5207 · `openFillSheet` 5211 · `closeFillSheet` 5229 · `saveFill` 5235 · `showFuelLog` 5266 · `closeFuelLog` 5275 · `copyFuelCsv` 5280

**Map**
`revealMap` 1694 · `offerMap` 1699 · `toggleMapView` 1733 · `loadMapPreference` 2210 · `setMapPreference` 2231 · `spreadOverlappingPins` 2266 · `clearOptionPins` 2294 · `addPendingPins` 2304 · `showOptionPins` 2311 · `drawTripRoute` 2419 · `loadGoogleMaps` 2638 (now loads OSM) · `loadOSMMap` 2643 · `initOSMMap` 2660 · `recentreMap` 2728 · `toggleMapMenu` 2762 · `selectMap` 2787 · `getMapUrl` 2798 · `navigateTo` 2830 · `closeMapSheet` 2838 · `openInMap` 2846

**Storage**
`persistProfile` 1844 · `applyProfile` 1899 · `loadProfile` 1904 · `resetConversation` 5550 · `saveSession` 5577 · `restoreSession` 5602 · `keepCtx` 5441 · `getCtx` 5442 · `notePlaces` 5429

**Logging**
`logResume` 4434 · `voiceLogAsText` 6554 · `voiceLogFullText` 6562 · `openVoiceLog` 6566 · `closeVoiceLog` 6575 · `copyVoiceLog` 6576 · `shareVoiceLog` 6585 · `_vlStart` 6609 · `_vlEnd` 6610 · `_vlAttach` 6616

**Other (UI shell, setup, vehicles, weather, accommodation, POI, SOS, versioning)**
`updateGreeting` 1629 · `satNavName` 1644 · `renderGuidance` 1651 · `showHome` 1657 · `openAppView` 1666 · `backHome` 1673 · `renderSoloIndicator` 1833 · `pickSetupRig` 1840 · `pickSetupFuel` 1841 · `toggleSetupApp` 1842 · `openSetup` 1854 · `editSetup` 1876 · `saveSetup` 1878 · `showWhere` 1944 · `hideWhere` 1950 · `renderVehiclePrompt` 1959 · `pickTodaysVehicle` 1989 · `quickStart` 1995 · `openVehicleSheet` 2490 · `closeVehicleSheet` 2491 · `chooseVehicle` 2496 · `selectVehicle` 2501 · `updateSuggestions` 2522 (no-op) · `fetchWeather` 2739 · `toggleAppMenu` 2768 · `closeAppMenu` 2772 · `menuGo` 2774 · `toggleChip` 2876 · `setCond` 2905 · `closeCondSheet` 2906 · `applyConditions` 2911 · `cleanText` 2933 · `addMsg` 2957 · `showTyping` 3084 · `hideTyping` 3090 · `fetchAccom` 5295 · `fetchPoi` 5352 · `openSOS` 5450 · `closeSOS` 5536 · `copyLocation` 5542 · `checkVersion` 6460 · `reloadForUpdate` 6482 · `showUpdateBanner` 6487 · `stampOnly` 6503 · `setVersionLine` 6507 · `dismissVersionLine` 6511 · `versionLineAction` 6514 · `toggleVersionLine` 6518

---

## 2. Carry-over verdicts

| Part | Verdict | Reason |
|---|---|---|
| **Geocode and reverse-geocode client** (`geoFetch`, `revGeoFetch`, `geocodePlace`) | **CARRY** | About 30 self-contained lines. They depend only on `API_URL`, and they already separate *failed* from *empty*. |
| **Camps request + card rendering** (`fetchMergedCamps`, `dedupeCampSites`, `sharesNameToken`, `isFreeNature`/`isFreeGroupEligible`, `pickFreeCampGroup`, `campCardNote`, `buildCampCard`, `renderCampCards`, `formatCampsAnswer`) | **CARRY WITH WORK** | The merge, dedupe, free-camp and card-note logic is pure and field-proven. It has to be untangled from four things. **(1)** `addMsg` chat bubbles: cards are injected into a chat bubble. **(2)** Globals: `campRound`, `campFilter`, `currentRunDest`, `CAMPS_SHOWN_MAX`. **(3)** Speech: `formatCampsAnswer` builds spoken text and caps at 10 sites, where the rebuild wants 3. **(4)** Drive-time lookups: the `getCorridorCamps`/`getCampsNear` wrappers read `gps`, `window._tripRoute`, `currentVehicle` and `campWidenScale`. |
| **Place-phone lookup + green dial button** (`verifiedPhone`, `localPhone`, `phoneMiss`, `roundCallButton`, card 📞) | **CARRY WITH WORK** | The `/place-phone` lookup no longer exists: it was retired in phase 4, and numbers now arrive with `/camps2` records. The `tel:` button and the number helpers are tiny and clean. Untangle from `noteCampCalled`/`campRound` and `scrollControlIntoView`, which depends on the chat. |
| **Ring-around loop** (`startCampRound` … `campOutcome`, `promptCallOutcome`, `checkCampReturn`, `widenCampSearch`, `handleRingAroundVoice`) | **CARRY WITH WORK** | This is the right model: a persisted round, a `tried[]` list, `calledSite` + `calledAt`, an "Any joy?" prompt on return with Booked / No room / No answer, then the booked site handed to the map. But every step is wired to `addMsg`/`speak`/`setPending`/`Voice.requestSession`/`answerCamps`. Keep the state machine and rewrite the UI around it. |
| **Fuel corridor logic** (`fetchFuelPrices` plus `freshPrices`, `distToRoute`, `progressAlongRoute`, `roadDistances`) | **CARRY WITH WORK** | Several pieces are worth lifting: the OSM-stations + govt-prices join, the "ahead on route" filter, the destination-end fetch, and the 72 h price-freshness rule. Two things need untangling. First, it returns an **AI prompt string**, not data. Second, it writes `fuelShortlist`, the pins and `notePlaces`. It also has **no range, open-hours or diesel-stock logic** (see §4), and nothing computes "the servo after the next one". |
| **Duration formatting** (`hrsMins`, `hrsMinsSpoken`) | **CARRY** | Two pure 6-line functions that follow the locked wording convention. `distTime`/`timePhrase` come with them. |
| **Trip and round storage** (`commitDestination`/`loadCommittedDest`, `navigator_last_trip*`, `saveCampRound`/`loadCampRound`, `saveSession`) | **CARRY WITH WORK** | Keep the committed-destination record `{name,lat,lon}` and the camp round with its 24 h expiry. Leave `saveSession` (chat HTML plus AI `messages`) and the three overlapping trip keys (`navigator_last_trip`, `_raw`, `_trip_plan`). There is also a **bug**: `loadTripCampRound` passes `ans.anchor`, but `formatCampsAnswer` never returns an `anchor`, so every persisted round has `anchor:null` and the "rebuild trip from round" restore never fires. |
| **Route computation** (`plotTripRoute` + `committedCoordsFor`, `distKm`, `distToRoute`, `progressAlongRoute`, `roadDistances`, `checkRoadSnap`) | **CARRY WITH WORK** | The OSRM route/table calls and the path helpers are clean. But `plotTripRoute` writes `window._tripRoute`, reads the global `gps`, *throws* when the destination isn't committed, and calls `drawTripRoute`. Make it a pure `route(from,to)` that returns `{km,mins,path}`. It uses the public `router.project-osrm.org` demo server, which has no SLA. |
| **Map and pins** (`initOSMMap`, `showOptionPins`, `spreadOverlappingPins`, `drawTripRoute`, `navigateTo`/`openInMap`) | **CARRY WITH WORK** | For the handover, take `openInMap`'s per-app deep links (Apple, Google, Waze), which already use coordinates and trip-waypoint routing. The Leaflet map and pins are optional in the rebuild. If kept, three things need fixing. **(1)** Popups inject `p.name` unescaped into HTML. **(2)** `initGPS`'s `watchPosition` calls a Google-Maps `setPosition` on a Leaflet marker. **(3)** Leaflet loads from unpkg at runtime. |
| **Share-log** (`shareVoiceLog`, Worker `/log`) | **LEAVE** | It is built around `Voice.getLog()` and the voice ring buffer. The Worker `/log` endpoint itself is generic and reusable if the rebuild wants a diagnostics upload. |
| **Fuel logbook** (`saveFill`, `showFuelLog`, `copyFuelCsv`) | **LEAVE** | Neither job needs it. If wanted later, it is self-contained (one localStorage key, L/100 km, CSV) and could be lifted as is. |
| **Test suites** (`voice_bench.mjs`) | **LEAVE** | It tests only the old voice state machine plus regexes against the current `index.html`. No camps, fuel or worker benches exist in the repo. |

---

## 3. Worker endpoints (`worker-camps.js`)

**Common behaviour across endpoints:**
- **Routing:** requests are dispatched by exact path. A handler that throws becomes `503 {"error":"<route> lookup failed","unavailable":true}`.
- **CORS:** CORS is set to `https://csbowring6-source.github.io` only. That restricts browsers, but curl and other clients are not restricted.
- **Fallthrough:** any unlisted path (including `/`) is proxied to Anthropic.
- **Test call:** requests below used Innisfail QLD at `lat=-17.5242&lon=146.0311`, one GET per endpoint. POST endpoints were not called.

| Endpoint | Params | Source | Cache | On failure |
|---|---|---|---|---|
| `GET /version` | none | constant `WORKER_BUILD` | none | n/a |
| `GET /geocode` | `q` (req), `limit` 1–5, `addr=1`, `lat`,`lon`,`bounded=1`,`vbd` (viewbox bias) | Nominatim `/search` (countrycodes=au), 8 s timeout, 1 retry | KV `geo:<norm q>|…` 30 days, **only non-empty hits** | 400 no `q`; **502** `{error:"geocoder unavailable",detail,unavailable:true}`; a real no-match is `200 {data:[]}` |
| `GET /reverse-geocode` | `lat`,`lon` (req), `zoom` | Nominatim `/reverse` | KV `rev:<lat3>,<lon3>|z` 7 days | 400; 502 as above |
| `GET /fuel` | `lat`,`lon` (req), `type` U91/P95/P98/DL/E10 (default U91), `radius` km (default 25; capped 100 for QLD/SA) | By position: WA FuelWatch RSS · SA / QLD Informed Sources FPDAPI · NSW FuelCheck v2 (details in §4) | FPDAPI in-memory: site list 12 h, prices 6 min · NSW token 11 h · no KV | 400; throws → 503 `fuel lookup failed`. WA returns `[]` if Nominatim finds no suburb. **Top 8 by price**. |
| `GET /stations` | `lat`,`lon`, `radius` (default 30, max 60) | Overpass `amenity=fuel` | in-memory 30 min (shared `overpass()`) | 503 `{error:"stations lookup failed",detail,unavailable:true}` |
| `GET /camps` | `lat`,`lon`, `radius` (default 40, max 100) | Overpass `tourism=camp_site|caravan_site` | in-memory 30 min + KV `camps:` 7 days (**stale-serve** on Overpass failure) | 503 `camps lookup failed` if no stale copy |
| `GET /camps2` | `lat`,`lon`, `radius` (default 40, max 100; Places bias capped 50 km) | Google Places (New) `searchText` "caravan parks and camping grounds", max 20, field mask id/displayName/formattedAddress/location/nationalPhoneNumber/regularOpeningHours | KV `camps2:` **30 days**, checked first | 503 no key / network; 502 Places non-200 or unreadable |
| `GET /camps2-osm` | `lat`,`lon`, `radius` (default 40, max 100) | Overpass camps + `highway=rest_area`, filtered by `isNonCommercialCamp` | KV `camps2-osm:` 7 days, checked first; in-memory 30 min | 503 `camps lookup failed` |
| `GET /accom` | `lat`,`lon`, `radius` (default 30, max 60) | Overpass hotel/motel/hostel/guest_house/apartment | in-memory 30 min | 503 |
| `GET /poi` | `lat`,`lon`, `kind` (gym, cafe, food, supermarket, pharmacy, pub, bakery, medical, laundry, toilets, atm, mechanic), `radius` (max 60) | Overpass | in-memory 30 min | 400 unknown kind; 503 |
| `GET /weather` | `lat`,`lon` | OpenWeatherMap 2.5 current, metric | none | upstream status and body passed through |
| `GET /places-probe` | `q` (req), optional `lat`,`lon` (15 km bias) | Google Places `searchText`, raw | **none**, `no-store` | 400 / 500 no key / 502. Marked TEMPORARY and still deployed. |
| `POST /transcribe` | audio body (webm/mp4) | OpenAI `whisper-1` with the AU town-hint prompt | none | 405 / 503 / 400 / 502. Not called. |
| `POST /log` · `GET /log/<id>` | text body ≤ 64 KB · 4–16 char id | KV `log:<id>` | 7 days | 503 no KV, 413 too big; GET 404 `Log not found or expired.` |
| `POST /` (fallthrough, any other path) | Anthropic Messages body | `api.anthropic.com/v1/messages` | none | upstream passthrough. Not called. |

**Overpass helper:**
- Uses four mirrors (openstreetmap.fr, z.overpass-api.de, maps.mail.ru, overpass-api.de), raced in pairs.
- Each attempt is capped at 6 s, with a 13 s total deadline.
- Serves a stale in-memory copy if every mirror fails.

### Real responses (trimmed), 28 Sep 2026

**`/version`** (200, 0.9 s)
```json
{"version":"Navigator Worker — 12 Aug 2026, 07:23 PM AEST (CAMPS-EARS: the /transcribe hint gains 'camps' — the app's own advertised keyword joins the command vocabulary)"}
```
**The deployed Worker matches the repo.** The live `WORKER_BUILD` string is identical to `worker-camps.js:707`, and the last commit touching the file is `c4b17c1 CAMPS-EARS`. Response shapes observed below also match the source. (The stamp is a label, so a byte-level match can't be proven from outside, but nothing observed contradicts it.)

**`/geocode?q=Innisfail QLD`** (200, 2.6 s, `cached:false`)
```json
{"cached":false,"data":[{"lat":"-17.5241605","lon":"146.0311385","addresstype":"town","name":"Innisfail","display_name":"Innisfail, Queensland, Australia", "…":"…"}]}
```
**`/reverse-geocode`** (200, 2.4 s)
```json
{"cached":false,"data":{"display_name":"Edith Street, Innisfail Retail Zone, Innisfail, Queensland, 4860, Australia","address":{"road":"Edith Street","town":"Innisfail","state":"Queensland","postcode":"4860"}, "…":"…"}}
```
**`/fuel?type=DL`** (200, 1.9 s)
```json
{"source":"QLD Fuel Prices","fueltype":"DL","radiuskm":25,"results":[
 {"name":"Astron Silkwood","address":"2 Silkwood Japoon Rd","price":279.9,"fueltype":"DL","lat":-17.748,"lon":146.027,"updated":"2026-09-25T19:50:19"},
 {"name":"Pearl Energy Wangan","address":"66 Meyer Ave","price":280.5,"fueltype":"DL","lat":-17.578,"lon":146.007,"updated":"2026-09-21T02:47:53.51"},
 {"name":"Mobil Mourilyan","address":"26 Bruce Highway","price":282.5,"…":"…"} ]}
```
There are no hours and no open or stock flag. Some prices are 7 days old, so the app's 72 h filter matters.

**`/stations`** (200, 2.0 s)
```json
{"source":"OpenStreetMap","radiuskm":30,"cached":false,"results":[{"name":"BP","brand":"BP","lat":-17.5265,"lon":146.0283},{"name":"Mobil","brand":"Mobil","lat":-17.5239,"lon":146.0201},{"name":"Caltex Woolworths","brand":"Ampol","…":"…"}]}
```
**`/camps`** (200, 6.5 s)
```json
{"source":"OpenStreetMap","radiuskm":40,"cached":false,"results":[{"id":"node/1292952252","name":"River Drive Caravan Park","type":"caravan park","lat":-17.535,"lon":146.030,"fee":"","powered":"","dump":"","toilets":"","water":"","phone":"","internet_access":"","shower":"","swimming_pool":""}, "…"]}
```
**`/camps2`** (200, 2.9 s, `cached:false`. This call was a billed Places request.)
```json
{"source":"places","radiuskm":40,"cached":false,"results":[
 {"id":"ChIJ3zvwFf_beGkRw4K3MYL65YM","name":"CMCA RV Park Innisfail","type":"caravan park","lat":-17.533,"lon":146.030,"address":"3 River Ave, Mighell QLD 4860, Australia","phone":"1300 787 275","hours":["Monday: 8:00 AM – 6:00 PM","…"],"source":"places"},
 {"id":"ChIJ0TEm7s3aeGkRDYno30ivhJQ","name":"BIG4 Innisfail Mango Tree Tourist Park","phone":"(07) 4061 1656","…":"…"} ]}
```
**`/camps2-osm`** (200, 7.5 s)
```json
{"source":"osm","radiuskm":40,"cached":false,"results":[
 {"id":"node/1811175480","name":"Fred Drew Rest Area","type":"camp site","lat":-17.515,"lon":145.994,"address":"","phone":"","hours":null,"source":"osm"},
 {"id":"node/1811175997","name":"Garradunga Hotel","type":"camp site","…":"…"},
 {"id":"node/4907277407","name":"Liverpool Creek Rest Area","type":"rest area","…":"…"} ]}
```
**`/accom`** (200, 5.3 s)
```json
{"source":"OpenStreetMap","radiuskm":30,"cached":false,"results":[{"name":"Moondarra Motel","type":"motel","stars":"","lat":-17.527,"lon":146.029}, "…"]}
```
**`/poi?kind=toilets`** (**503**, 12.4 s). This is a real failure: the Overpass mirrors were down.
```json
{"error":"poi lookup failed","detail":"timeout from https://maps.mail.ru/osm/tools/overpass/api/interpreter; HTTP 521 from https://overpass-api.de/api/interpreter","unavailable":true}
```
**`/weather`** (200, 1.9 s)
```json
{"weather":[{"main":"Clouds","description":"overcast clouds"}],"main":{"temp":23.81,"humidity":80},"wind":{"speed":6,"deg":148},"name":"Innisfail","cod":200}
```
**`/places-probe?q=caravan parks in Innisfail QLD`** (200, 1.9 s. This call was a billed Places request, with raw Google output.)
```json
{"places":[{"id":"ChIJ16z2m7faeGkRKoBfk9TJPZk","nationalPhoneNumber":"(07) 4063 2211","formattedAddress":"64174 Bruce Hwy, Innisfail QLD 4860, Australia","location":{"latitude":-17.5577,"longitude":146.0353},"displayName":{"text":"August Moon Caravan Park"}},
 {"displayName":{"text":"BIG4 Innisfail Mango Tree Tourist Park"},"regularOpeningHours":{"openNow":true,"periods":[{"open":{"day":0,"hour":8,"minute":0},"close":{"…":"…"}}]}, "…":"…"} ]}
```
The raw Places response carries `openNow` and structured `periods`. `/camps2` throws these away and keeps only `weekdayDescriptions` strings.

**`/log/ZZZZZZZ`** (404, test id): `Log not found or expired.`

### Worker observations relevant to the rebuild

- **The Anthropic fallthrough is an open relay.** Any non-browser client can POST any body to any path and spend Anthropic credit, because CORS doesn't stop curl. `/transcribe` is equally open. If the rebuild has no AI chat, remove the fallthrough.
- **`/places-probe` is still live.** It is uncached and billable per call.
- **`/stations` drops OSM `opening_hours` and fuel tags,** even though Overpass returns them (see §4).
- **`/fuel` routes by lat/lon rectangles, not by state:**
  - `lon<129` goes to WA.
  - `lat≤-26 && lon≤141` goes to SA.
  - `lat≥-29` goes to QLD.
  - Everything else goes to NSW.

  So the **NT goes to the QLD feed** and returns nothing useful. **Victoria goes to NSW FuelCheck**. And the strip of northern NSW above −29° (Tweed, Ballina, Lismore, Moree) goes to the **QLD** feed.

---

## 4. Fuel feeds

| State | Feed the Worker calls | Diesel availability? | Opening hours? |
|---|---|---|---|
| **NSW** | NSW FuelCheck API v2 `prices/nearby` (OAuth, key + secret) | **No stock flag.** A station appears for `DL` only if it has a DL price, so "sells diesel" can be inferred from the price, but it is not an in-stock signal. | **No** |
| **TAS** | No separate feed. Tasmanian coordinates fall through to the NSW FuelCheck branch, and FuelCheck is documented as carrying Tasmanian stations, but this was **not verified**: no Tasmanian request was made. | Same as NSW | **No** |
| **QLD** | Informed Sources FPDAPI (`fppdirectapi-prod.fuelpricesqld.com.au`, `QLD_TOKEN`) | No stock flag; sells-diesel can be inferred from a DL price being present | **No.** The site-details call is fetched, but hours are not passed through. |
| **SA** | Informed Sources FPDAPI (`fppdirectapi-prod.safuelpricinginformation.com.au`, `SA_TOKEN`) | Same as QLD | **No** (same) |
| **WA** | FuelWatch RSS (`fuelwatch.wa.gov.au/fuelwatch/fuelWatchRSS`), suburb found via Nominatim reverse | No stock flag; the `Product=4` query returns diesel sellers | **No** |
| **VIC** | **Not covered.** VIC coordinates fall into the NSW FuelCheck branch, which will only return NSW (or TAS) stations inside the radius. | — | — |
| **NT** | **Not covered.** NT coordinates fall into the QLD branch, which only returns QLD stations near the border. | — | — |
| ACT | Falls into the NSW branch (FuelCheck covers some ACT border stations); not verified | — | — |

**Plainly: Victoria and the Northern Territory are not covered.** Neither has a feed call. Their coordinates are sent to the wrong state's API and come back empty or border-only. The app then shows OSM servos with "price unconfirmed".

**Where hours could come from:** none of the fuel feeds deliver opening hours today, and nothing in the Worker or the app knows whether a servo is open. There are two possible sources:
- **(a) OSM `opening_hours` on `amenity=fuel`.** It is free and already in the Overpass response, but `/stations` discards it. Coverage is patchy in the bush.
- **(b) Google Places `regularOpeningHours` / `openNow`.** The field mask used for camps already includes it, but it is billable per lookup.

**Diesel:** "sells diesel" can come from the presence of a DL price (govt feeds), or from OSM `fuel:diesel=yes` (also discarded today). No source gives "diesel in stock right now".

**Range:** the app has no numeric range logic. `chooseRange` only sets a chip label, and the label reaches the AI prompt as text. (`VEHICLES.range` is a search distance, not a tank range.) The fuel-warning job will need that logic written new.

---

## 5. Secrets and bindings the Worker reads (names only)

| Name | Kind | Used by |
|---|---|---|
| `GOOGLE_PLACES_KEY` | secret | `/camps2`, `/places-probe` |
| `ANTHROPIC_API_KEY` | secret | root / fallthrough AI proxy |
| `OPENAI_API_KEY` | secret | `/transcribe` (**not listed** in `wrangler.toml`'s comment of preserved secrets) |
| `NSW_API_KEY` | secret | `/fuel` (NSW) |
| `NSW_API_SECRET` | secret | `/fuel` (NSW OAuth) |
| `QLD_TOKEN` | secret | `/fuel` (QLD FPDAPI) |
| `SA_TOKEN` | secret | `/fuel` (SA FPDAPI) |
| `WEATHER_KEY` | secret | `/weather` |
| `PLACES_KV` | KV namespace binding | caches for `/camps`, `/camps2`, `/camps2-osm`, `/geocode`, `/reverse-geocode`; storage for `/log` |

WA FuelWatch, Nominatim, Overpass and OSRM need no keys.

---

## 6. What works on the phone with no signal

There is no service worker and no manifest, so **the app itself will not load offline**: a cold open with no signal fails. If the page is already open (or restored from the browser's cache), the following localStorage data and bundled code keep working.

| Stored / bundled | Key | Works offline? |
|---|---|---|
| Profile: name, rig, fuel, height/length, owned map apps, solo contact | `navigator_profile` | Yes |
| Preferred sat-nav app | `navigator_map_pref` | Yes. The deep link opens; whether the map app routes offline depends on that app. |
| Committed destination `{name,lat,lon}` | `navigator_committed_dest` | Yes. The coordinates are enough to hand over to the map app with no lookup. |
| **Last camp round**: up to 10 sites with **name, lat/lon, phone, hours, type, free flag, tried list** (24 h expiry) | `navigator_camp_round` | **Yes. This is the key offline asset:** tap-to-call (`tel:`) and "navigate to" both work with no data. |
| Trip context / raw trip / locked plan | `navigator_last_trip`, `navigator_last_trip_raw`, `navigator_trip_plan` | Yes (text and small JSON) |
| Saved trips / stops | `navigator_saved_trips` | Yes |
| Manual location | `navigator_manual_loc` | Yes |
| Last session: chat HTML (last 6 bubbles), last 12 AI messages, pins (4 h expiry) | `navigator_session` | It displays, but nothing new can be asked. |
| Fuel logbook (last 100 fills, L/100 km, CSV copy) | `navigator_fuel_log` | Yes. Adding a fill works; the servo-name autofill needs signal. |
| Voice event log | `speech.js` `VLOG_KEY` | View and copy work; Share needs signal. |
| **`AU_TOWNS` gazetteer** (~2,968 towns with coordinates, bundled in the page) | in `index.html` | **Yes.** Town-name matching and coordinates work offline. |
| `hrsMins`, `distKm`, straight-line distances | code | Yes |

**Needs signal:** every Worker call (camps, fuel, geocode, weather), OSRM routing and road distances, map tiles, Leaflet (loaded from unpkg), and the AI.
