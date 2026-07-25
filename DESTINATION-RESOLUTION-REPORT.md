# Destination Resolution — Trace

*26 Jul 2026 · code reading. No code changed.*

## Is the destination stored once and reused, or re-derived at each step?

**Re-derived.** The destination **name** (`currentRunDest`) is the single source of truth and is reused. The resolved **coordinates** are stored in exactly one place — `window._tripRoute.dlat/dlon` — and **read back in exactly one place: `plotTripRoute`'s own cache** (index.html:1853). No other step reads those stored coords. The **camps lookup** and **navigation** bypass them and re-resolve from the name string, so the same named destination is geocoded independently at multiple steps and can resolve to different points — the exact decoupling behind the Cardwell→Caldwell bug.

## Every place the destination is resolved from user input (not read from a stored coord record)

| # | Site (line) | What it resolves | Reuses stored coords? |
|---|---|---|---|
| 1 | `resolveDestination(spoken)` (917) | geocodes the spoken destination for the scale/name-drift check **before commit** | n/a — it *is* the resolve step; result seeds `window._tripRoute` via `adoptTripAt` |
| 2 | `plotTripRoute(dest)` (1856) | geocodes the destination name for the **route + km/hours** | **Partially** — reuses `window._tripRoute` if `dest` matches and `dlat` is present; otherwise **re-geocodes** (resume, recall, deviation-refresh, or after cache clear) |
| 3 | `getCampsNear(place)` → `geocodePlace(place)` (3521→3507) | the **camps lookup** geocodes the destination name again (a bare camps ask on a trip sets `named = currentRunDest`) | **No** — never reads `window._tripRoute`; independent geocode |
| 4 | `geocodeLocal(name)` (944) | geocodes GPS-bounded for the **"near me"** disambiguation pick | n/a — deliberately re-resolves |
| 5 | `geocodePlace(name)` (3504) | generic geocoder used by camps (#3) and `geocodeLocal`'s no-GPS fallback | **No** |
| 6 | `openInMap()` (navigation) | passes `currentRunDest + ' Australia'` (the **name**) to Google/Apple/Waze as the trip-destination waypoint — **re-geocoded externally** | **No** — stored coords (`currentNavCoords`) are used only for map-**pin** navigation, never the trip destination |
| 7 | `whereTo()` (1431) | legacy speech trip-start path; geocodes directly, bypassing `resolveDestination` | **Effectively dead** — reads `#whereInput`, an element deleted with the old start overlay (0 in markup), so it throws if reached. Listed for completeness. |

`parseTripIntent` parses the destination *name* from the utterance (no geocode) → `currentRunDest`. Separately, `setManualLocation` (2004) geocodes the driver's own **position/origin**, not the destination — stored once in `gps`.

## Bottom line
- **Route:** reuses the stored coords **when the cache is warm**, re-geocodes otherwise.
- **Camps lookup:** always re-geocodes the destination name — never reads the stored coords.
- **Navigation:** always hands the destination **name** to the external map app — never the stored coords.

So a request does **not** carry one resolved destination through route → camps → navigation. The disambiguation fix (`adoptTripAt`) binds coords at commit and seeds the route cache — fixing the *route* step — but **camps (#3) and navigation (#6) still re-resolve from the name** and can diverge from what the route committed to. This is the concrete remnant of the shared root with ticket #2.

**If you want "resolve once, reuse everywhere":** have `getCampsNear` and `openInMap` read `window._tripRoute.dlat/dlon` when the place is the current trip destination, instead of re-geocoding.
