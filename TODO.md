# Navigator — Pending Tickets

Numbered backlog. Each entry is a short name plus the full instruction text. Nothing here is implemented yet — do not start any of these without a go-ahead.

1. **Duration sweep** — Convert all duration output to hours and minutes ("1 hr 35"), never total minutes, never decimal hours.

2. **Destination persistence** — A user correction must overwrite the stored trip destination; trace every read and write of it.

3. **Destination disambiguation** — When a spoken place name is ambiguous or resolves wildly out of scale with the current trip, ask before committing.

4. **Ring-around loop** — Persist camps results to storage, prompt for call outcome on return, advance to the next site's number, offer Navigate on success.

5. **Phone numbers via Places API** — Fetch on request for a named site, bind the number to that site record, cache results.

6. **User-contributed amenity data** — Prompt after a stay to confirm amenities, store in D1, read own data before OSM.
