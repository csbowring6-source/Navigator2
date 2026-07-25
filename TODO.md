# Navigator — Pending Tickets

Numbered backlog. Each entry is a short name plus the full instruction text. Items marked _Shipped_ are done (commit noted); the rest are pending — do not start any pending item without a go-ahead.

1. **Duration sweep** — Convert all duration output to hours and minutes ("1 hr 35"), never total minutes, never decimal hours.
   - _Shipped `3b5ed63` — all deterministic output routed through `hrsMins`/`hrsMinsSpoken`. Follow-up: the AI-context `routeCtx` still passes decimal hours to the model (deliberately, as a base figure for its leg-planning maths); revisit if the AI ever echoes a decimal._

2. **Destination persistence** — A user correction must overwrite the stored trip destination; trace every read and write of it.

3. **Destination disambiguation** — When a spoken place name is ambiguous or resolves wildly out of scale with the current trip, ask before committing.

4. **Ring-around loop** — Persist camps results to storage, prompt for call outcome on return, advance to the next site's number, offer Navigate on success.
   - _Shipped `7944df7` (loop + call-outcome prompt + advance) and `59a0e5d` (Navigate to booked site from the stored record). Note: "widen the search area" uses an opt-in radius multiplier (`campWidenScale`, default 1); the search ranking/selection logic is unchanged._

5. **Phone numbers via Places API** — Fetch on request for a named site, bind the number to that site record, cache results.

6. **User-contributed amenity data** — Prompt after a stay to confirm amenities, store in D1, read own data before OSM.
