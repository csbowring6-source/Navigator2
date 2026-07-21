# Navigator — Product Spec v1.2

*Craig Bowring · 21 July 2026 · incorporates Brian's field download · to be committed to the repo beside CLAUDE.md*

---

## 0. The make-or-break principle

**Honesty.** The app states what it can't do before the user discovers it, and is generous about what the rest of the phone can do. No feature may silently overpromise — the product's shortfall must never be billed to the user's confidence. Every section below carries this tag; where data is patchy the app says so, and where a wall exists (background tracking, other apps' data, auto-dialling) the app names it and routes around it honestly.

## 1. What Navigator is — one sentence

**Navigator is a voice-first travel co-pilot for Australian road trippers — especially caravanners — that plans the journey, finds what you need along the way, and hands the actual driving to a real sat-nav.**

Navigator thinks. Google Maps steers. Nothing on screen may contradict that sentence.

## 2. The benchmark query

Named independently by both testers, this is the sentence every build must answer perfectly before anything else matters:

> **"Find me a campsite — free or otherwise — within the next hour along my route."**

A correct answer requires: direction of travel (GPS heading — ahead only, never behind), drive-time not straight-line distance, free/paid honoured, rig fit as a hard filter, amenities spoken, and every result carrying Navigate + 📞 Call + owned-app handoffs.

## 3. Operating rhythm

**Drive → Stop → Brief → Decide → Confirm → Navigate.**
Navigator cannot watch the road while Google steers (web app, no background tracking — the app says so). Every natural stop re-engages Navigator: it volunteers the next-150km picture first — fuel, weather, camps, plan status — then listens. Resume is core: open the app mid-trip and it knows ("Day 2, leg to Townsville, 340km run — want the briefing?"). The rhythm is taught in the guidance.

## 4. Voice — the interface

- **Conversation mode is primary** (Brian: many travellers drive older vehicles with no in-car tech). **Tap-to-talk is the always-available fallback**, and the app manages the handover honestly: if it detects repeated mishearing, *it* suggests the switch — "noisy cab — tap-to-talk will work better."
- No fixed command phrases, ever. Natural speech in; the weak link is the phone's hearing in noise, and the app says so.
- Answers are **spoken first**: the whole experience must work hands-free without pulling over to interrogate websites.
- Guidance notes that a Bluetooth/CarPlay mic transforms recognition.
- Voice output = the phone's built-in TTS (user-chosen voice/speed, Australian English requested). Premium voices noted as a possible later upgrade; reliability beats beauty in a driving app.

## 5. Answers — the rule of three

Spoken: **one best fit + two alternatives, then stop talking.** ("Best fit: Big4 Bowen, 40 minutes ahead — powered, showers, dump point. Also: free camp Boulder Creek, 55 minutes, toilets only; or Proserpine showgrounds, 35 minutes, power unconfirmed. Want more, or shall I line one up?")
Selection parameters come from context, not interrogation: direction of travel (always ahead), stated or default (~1hr) time window, rig fit (hard filter from profile), free/paid when stated, ranked by fit → detour cost → value.
**Honest edges:** if the window is empty, say so and widen — never pad with junk. Amenity fields the data can't confirm are flagged ("power unconfirmed — worth a call"), and drive-through / no-unhitching intel is named as community knowledge → WikiCamps handoff.
Visual: the same answer renders as a **list view** (name, distance, amenities, price) and **map pins** (position relative to the road), toggleable. The **yellow route line** start-to-finish stays, as the trip card's picture.

## 6. Camps — first-class citizens

- Camp options baked into every leg of the trip plan, refreshed at stop briefings; the afternoon (☕) stop surfaces tonight's options with Call buttons ready.
- Types and amenities spoken: powered, water, showers, toilets, dump point, pool, big-rig/drive-through where known. **Free camps get explicit focus** — sourced from OSM/open data and live web search, which cover the sites; WikiCamps holds the community soul (reviews, conditions) and gets the handoff.
- **📞 Call is the accuracy tool**: no database knows tonight's availability; the office does. The app finds the number and readies the call — a human taps to dial (the phone requires it; the app says so rather than pretending).

## 7. Other apps — open and point, never task

Navigator can *open* another app and sometimes *point* it (deep links); it can never *task* one or read its data — that wall is Apple's and Google's, and the app says so. Doctrine: **Navigator answers the question; specialist apps enrich the answer.** Setup asks **which apps the traveller already owns** (WikiCamps, Hipcamp, Fuel Map, BOM…) and those become their personal handoff buttons on every relevant result. Navigator is the co-pilot that knows every instrument in the cockpit.

## 8. Solo mode — the differentiator

Armed by voice ("it's just me this trip") or in setup; shows a small visible indicator. Three layers:
1. **The answers change** — solo-lens ranking (staffed parks, populated grounds, arrival-before-dark preference), described honestly; "how safe it feels" is community knowledge → WikiCamps handoff gets prominence. Never paternalistic: she asked for free camps, she gets free camps.
2. **Someone always knows** — a trusted contact captured once; stop briefings offer one-tap pre-written check-in texts ("Arrived Bowen, all good — Marie always knows where you last were"). No background tracking and no dead-man alerts — a web app can't honestly promise them, so it doesn't.
3. **The cab is never silent unless you want it** — the companion layer. Warmer, chattier briefings; conversation at the lookout; noticing the journey. Talking keeps solo drivers alert — the warmth does safety work. The companion never pretends to be a person and points outward: it weaves the traveller's real people into the trip via check-ins rather than substituting for them.

## 9. SOS — the one permanent button

Emergencies are when speech fails (panic, injury, a partner who's never used the app). SOS stays as the single always-visible button. With Solo armed it gains the contact: one press offers 000 and "message [contact] my location."

## 10. The home screen

Minimal: **greeting + guidance** (what the app is, three example phrases, the rhythm) · **the mic**, big and central · **SOS** · **Solo indicator when armed** · **trip card** when a trip is live (yellow line, today's leg, resume). **The pegs are retired** — servo, break, camps are spoken requests now (two testers concur). **The map is fired as wallpaper** — it appears only as a results view.

## 11. Setup — the one-time interview

Ninety seconds, conversational, then it vanishes (revisited only when summoned or when a missing fact matters): name · what you drive (rig type, fuel, height/length — only what changes answers) · which apps you already use (→ handoff buttons) · solo contact if wanted. The interview is honest about *why* it asks: every question visibly changes answers.

## 12. What stays true in the code

Single file, no build step, GitHub Pages, `.nojekyll` in every push. Worker relay: /fuel /poi /camps /stations /accom /weather + Claude relay (web search capable for obscure camps). Claude Code writes; Craig pushes via GitHub Desktop; secrets never in chat. Bugs 1–3 dissolve into the restructure: GPS race (no idle map), welcome resurrection (page deleted, bfcache guard), Navigate hijack (modes make intent unambiguous; accommodation anchors to the named town).

## 13. Order of work

1. Commit this spec beside CLAUDE.md
2. CC session 1: home screen + setup interview + mode split (UI only, engine untouched)
3. CC session 2: results view (spoken-three / list / pins), camps + corridor logic toward the benchmark query
4. CC session 3: Solo mode (three layers) + SOS upgrade + handoff buttons
5. CC session 4: fold bug fixes; road-test against the benchmark query

---

*v1.2 supersedes v1.1. Changes: honesty elevated to §0; benchmark query named; pegs retired for spoken requests (SOS retained); Conversation primary with tap-to-talk fallback; camps/amenities/free-camp focus; call-ahead; owned-apps interview; Solo defined in three layers; rule of three; list+pins+yellow line confirmed.*
