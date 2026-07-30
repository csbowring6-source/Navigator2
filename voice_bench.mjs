// Phase 3 — VOICE MODULE BENCH RIG. Loads the REAL speech.js under mocked browser
// globals and drives its state machine with simulated event sequences. Also
// replays a pasted field event log so a real failure becomes a permanent case.
import fs from "node:fs";
const SRC = fs.readFileSync("/Users/craigbowring/Navigator/speech.js", "utf8");

// ── fake clock + timers (deterministic; Date.now follows the clock) ───────────
const clock = { now: 0 };
let timers = [];
const fakeSetTimeout = (fn, ms) => { const id = {}; timers.push({ id, fn, due: clock.now + (ms || 0) }); return id; };
const fakeClearTimeout = (id) => { timers = timers.filter(t => t.id !== id); };
const fakeRAF = () => 0;
const RealDate = Date;
const FakeDate = class extends RealDate { static now() { return clock.now; } };
function advance(ms) {
  const target = clock.now + ms;
  // run timers due within the window, in order, allowing re-scheduies
  for (let guard = 0; guard < 10000; guard++) {
    const due = timers.filter(t => t.due <= target).sort((a, b) => a.due - b.due)[0];
    if (!due) break;
    timers = timers.filter(t => t !== due);
    clock.now = due.due;
    due.fn();
  }
  clock.now = target;
}

// ── recogniser + synthesis + audio mocks ──────────────────────────────────────
const H = { rec: null, utt: null, started: 0, stopped: 0 };
class MockSR {
  constructor() { this.lang = ""; this.continuous = false; this.interimResults = false; H.rec = this; }
  start() { H.started++; }
  stop() { H.stopped++; if (this.onend) {/* real engines fire onend async; tests fire it explicitly */} }
  abort() { H.stopped++; }
}
class MockUtt { constructor(t) { this.text = t; this.onstart = null; this.onend = null; this.onerror = null; } }
const synth = {
  _cancels: 0,
  cancel() { this._cancels++; },
  speak(u) { H.utt = u; },
  getVoices() { return []; },
  onvoiceschanged: null,
};
function stubEl() {
  return { style: {}, className: "", textContent: "", value: "",
    classList: { toggle() {}, add() {}, remove() {} },
    appendChild() {}, };
}
const MockAudioCtx = class { constructor(){ this.currentTime = 0; this.destination = {}; } createOscillator(){ return { type:"", frequency:{}, connect(){}, start(){}, stop(){} }; } createGain(){ return { gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){} }, connect(){} }; } };
const mockWindow = { speechSynthesis: synth, SpeechRecognition: MockSR, webkitSpeechRecognition: MockSR, AudioContext: MockAudioCtx, webkitAudioContext: MockAudioCtx };
const mockNavigator = { userAgent: "bench", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }, permissions: { query: async () => ({ state: "granted" }) } };
// Persistent per-id elements so a test can read back what setMicState wrote (e.g. the
// #wakeBtn label). Existing scenarios never read element state, so persistence is inert
// for them; writes still land as before.
const _els = {};
const el = (id) => (_els[id] || (_els[id] = stubEl()));
const mockDocument = { getElementById: el, querySelectorAll: () => [], createElement: () => stubEl() };
const silentConsole = { log(){}, warn(){}, info(){}, error(){} };

// ── app-level globals the module calls by name (live in index.html) ───────────
globalThis.addMsg = () => {};
globalThis.setPending = () => {};
globalThis.pendingQuestion = null;
globalThis.pendingIsFresh = () => true;
globalThis.cleanTranscript = (t) => (t || "").trim();
globalThis.autoResize = () => {};
globalThis.API_URL = "https://bench.invalid/";
globalThis.lastSpoken = "";

// ── load the module with browser globals shadowed via function params ─────────
const loader = new Function(
  "window", "document", "navigator", "SpeechSynthesisUtterance", "setTimeout", "clearTimeout", "requestAnimationFrame", "Date", "console",
  SRC + "\nreturn window.Voice;"
);
const Voice = loader(mockWindow, mockDocument, mockNavigator, MockUtt, fakeSetTimeout, fakeClearTimeout, fakeRAF, FakeDate, silentConsole);
let delivered = 0, busyFlag = false;
Voice.onTranscript(() => { delivered++; });
Voice.setBusyGetter(() => busyFlag);

// ── event drivers (simulate the recogniser/TTS firing) ────────────────────────
const rec = {
  onstart: () => H.rec && H.rec.onstart && H.rec.onstart(),
  speech:  () => H.rec && H.rec.onspeechstart && H.rec.onspeechstart(),
  final:   (txt) => H.rec && H.rec.onresult && H.rec.onresult({ results: [Object.assign([{ transcript: txt }], { isFinal: true })] }),
  interim: (txt) => H.rec && H.rec.onresult && H.rec.onresult({ results: [Object.assign([{ transcript: txt }], { isFinal: false })] }),
  end:     () => H.rec && H.rec.onend && H.rec.onend(),
  error:   (e) => H.rec && H.rec.onerror && H.rec.onerror({ error: e }),
};
const tts = { start: () => H.utt && H.utt.onstart && H.utt.onstart(), end: () => H.utt && H.utt.onend && H.utt.onend() };

const kinds = () => Voice.getLog().map(e => e.kind + (e.detail ? ":" + e.detail : ""));
const count = (k) => Voice.getLog().filter(e => e.kind === k).length;
function fresh() { Voice.clearLog(); delivered = 0; busyFlag = false; H.started = 0; H.stopped = 0; H.rec = null; H.utt = null; }

let ok = true;
const check = (l, c, x) => { console.log((c ? " ok  " : "FAIL ") + l + (x ? "  " + x : "")); ok = ok && c; };

// ── SCENARIO 1: normal turn — open, speak, pause, deliver ─────────────────────
console.log("--- 1. normal turn delivers exactly once, no premature close ---");
fresh();
Voice.openSession();
rec.onstart(); rec.speech(); rec.final("cheapest fuel ahead");
advance(2800);                     // end-of-turn pause fires the deliver timer...
advance(600);                      // ...then the deliver->send debounce calls onTranscript
check("transcript delivered once", delivered === 1);
check("no close during a normal turn", count("close") === 0);
check("no cue during a normal turn", count("cue") === 0);
Voice.closeSession("tap");

// ── SCENARIO 2: TTS overlap — no capture while the app speaks ─────────────────
console.log("\n--- 2. no capture during TTS ---");
fresh();
Voice.openSession(); rec.onstart();
Voice.speak("here is your brief");   // convoSpeaking = true, recogniser stopped
tts.start();
const beforeResults = count("rec.onresult");
rec.final("this is the app hearing its own voice");   // must be ignored
check("mic state is 'speaking' during TTS", Voice.state() === "speaking");
check("recogniser result during TTS is ignored (no capture)", count("rec.onresult") === beforeResults);
check("nothing delivered from the app's own voice", delivered === 0);
tts.end();
Voice.closeSession("tap");

// ── SCENARIO 3: early-onend loop, NO delivery -> closes honestly, one cue ─────
console.log("\n--- 3. early-onend restart loop closes honestly, cue once ---");
fresh();
Voice.openSession();
for (let i = 0; i < 12; i++) { rec.onstart(); rec.end(); advance(300); }   // sub-healthy reopens
check("session closed honestly", kinds().some(k => k.startsWith("close:honest")));
check("cue fired at most once", count("cue") <= 1);
check("cue fired exactly once (a real close)", count("cue") === 1);

// ── SCENARIO 4: ambient-noise finalisation loop, VARIED cycle length ──────────
// Interim ambient resets the old restart cap (the leak) but never delivers; the
// cumulative reopen ceiling must still close it — regardless of cycle spacing.
console.log("\n--- 4. ambient loop closes regardless of cycle length ---");
for (const spacings of [[250,250,250,250,250], [100,5000,100,4000,100], [1900,1900,1900,1900,1900]]) {
  fresh();
  Voice.openSession();
  let closed = false;
  for (let i = 0; i < spacings.length + 3 && !closed; i++) {
    rec.onstart();
    rec.interim("mmm road noise");     // ambient: resets restart cap, never delivers
    rec.end();
    advance(spacings[i] != null ? spacings[i] : 200);
    closed = kinds().some(k => k.startsWith("close:"));
  }
  check("closed with no delivered turn [spacings " + spacings.join(",") + "]", closed && delivered === 0);
  check("...cue exactly once", count("cue") === 1);
}

// ── SCENARIO 5: the four close paths — each closes, cue once, state off ───────
console.log("\n--- 5. four close paths ---");
for (const reason of ["tap", "phrase", "silence", "honest"]) {
  fresh();
  Voice.openSession(); rec.onstart();
  Voice.closeSession(reason);
  check(reason + ": cue once + state off", count("cue") === 1 && Voice.state() === "off");
}

// ── SCENARIO 6: REPLAY a pasted field log ─────────────────────────────────────
// Capture a real failing sequence (scenario 4's loop), then replay ONLY its
// input-side events and assert the module reaches the same terminal (one cue,
// honest close). This is how a phone log becomes a permanent bench case.
console.log("\n--- 6. field-log replay reproduces the failure ---");
fresh();
Voice.openSession();
for (let i = 0; i < 8; i++) { rec.onstart(); rec.interim("noise"); rec.end(); advance(300); }
const fieldLog = Voice.getLog().slice();          // <- this is what a phone would paste
function replay(log) {
  fresh();
  for (const e of log) {
    if (e.kind === "open") Voice.openSession();
    else if (e.kind === "rec.onstart") rec.onstart();
    else if (e.kind === "rec.speechstart") rec.speech();
    else if (e.kind === "rec.onresult") rec.interim("noise");   // content not needed to repro control-flow
    else if (e.kind === "rec.onend") rec.end();
    else if (e.kind === "rec.onerror") rec.error(e.detail);
    else if (e.kind === "tts.start") tts.start();
    else if (e.kind === "tts.end") tts.end();
    // derived kinds (state/reopen/cue/close/deliver/offer) are regenerated, not injected
    advance(300);
  }
}
replay(fieldLog);
check("replay reproduces the honest close", kinds().some(k => k.startsWith("close:honest")));
check("replay reproduces exactly one cue", count("cue") === 1);
check("replay delivered nothing (matches the field failure)", delivered === 0);

// ── SCENARIO 7: TIMED replay of the 28 Jul 10:11AM convo beep-loop field log ───
// The full pasted sequence — a first turn that delivers, the app's reply, then a
// ~5s recogniser restart churn that NEVER delivers, with the driver's speech
// beginning mid-churn. Before the fix this ran 13 cycles / 70s (the alive>=2s reset
// leaked the no-delivery ceiling) and finally closed ON the driver's speechstart.
// After the fix it must end CLOSED honestly, at most one cue, closed by the reopen
// ceiling in ~3 reopens, with NO driver speechstart left ignored while "listening".
let base; const to = (sec) => advance(base + sec * 1000 - clock.now);   // advance the fake clock to an absolute second
console.log("\n--- 7. field replay (10:11AM beep loop): closes fast + honest, no undelivered speech ---");
fresh();
timers.length = 0;                       // drop any stale timers from earlier scenarios
let openSpeechPending = 0;               // speechstarts fired while OPEN, still awaiting a delivery
Voice.onTranscript(() => { delivered++; openSpeechPending = 0; });   // a delivery clears the pending speech
const trackedSpeech = () => { if (Voice.isSessionOpen()) openSpeechPending++; rec.speech(); };
base = clock.now;
Voice.openSession();
trackedSpeech();                          // 0s: driver starts speaking (turn 1)
to(1.0); rec.final("cheapest fuel");
to(2.0); rec.final("cheapest fuel to innisfail");
to(4.9);                                  // pause > CONVO_TURN_MS -> turn 1 delivers (~4.8s)
Voice.speak("The cheapest is 182.9 at the Ampol.");   // app replies -> pauses the session
to(5.0); tts.start();
to(6.0); tts.end();                       // reply ends -> convoHadExchange, resume after the tail
to(6.7); if (Voice.isSessionOpen()) rec.onstart();    // engine reopened for the next turn
// the churn: recogniser drops ~every 5s (each alive > 2s), delivering nothing
to(12.1); rec.end(); to(12.6); if (Voice.isSessionOpen()) rec.onstart();
to(17.5); rec.end(); to(18.0);            // this reopen hits the ceiling -> honest close
// driver tries again AFTER the honest close — must be ignored, never re-cued
to(25.5); trackedSpeech();
to(43.0); trackedSpeech();
check("turn 1 delivered (its results were NOT lost)", delivered === 1);
check("the beep loop closed honestly", kinds().some(k => k.startsWith("close:honest")));
check("exactly one close cue (not one per restart)", count("cue") === 1);
check("closed by the reopen ceiling in ~3 reopens, not 13", count("reopen") <= 4, "reopens=" + count("reopen"));
check("no undelivered speechstarts — driver speech is never left ignored while 'listening'", openSpeechPending === 0);
check("session is CLOSED at the end", Voice.isSessionOpen() === false);

// ── SCENARIO 8: speech during the anything-else offer window is CAPTURED ───────
// A delivered turn (so the offer is armed), 20s of quiet, the offer fires, and the
// driver answers it. The answer must be captured and delivered, and must NOT be the
// trigger that closes the session (the field 92.66->92.67 close-on-speechstart bug).
console.log("\n--- 8. speech during the anything-else offer is captured, never the closing trigger ---");
fresh();
timers.length = 0;
Voice.onTranscript(() => { delivered++; });
base = clock.now;
Voice.openSession();
rec.speech();
to(1.0); rec.final("camps at innisfail");
to(3.9);                                  // deliver turn 1 (~3.8s)
Voice.speak("Here are three camps near Innisfail.");
to(4.0); tts.start();
to(5.0); tts.end();                       // convoHadExchange=true; resume ~5.6 arms the offer at ~25.6
to(5.7); if (Voice.isSessionOpen()) rec.onstart();
to(25.7);                                 // offer fires (~25.6): speaks "Anything else?", stops the recogniser
check("anything-else offer fired", count("offer") === 1);
to(26.1); tts.end();                      // the offer utterance ends -> resume after the tail
to(26.8); if (Voice.isSessionOpen()) rec.onstart();   // listening for the ANSWER
const openBefore = Voice.isSessionOpen();
to(27.3); rec.speech();                   // the driver's answer BEGINS in the offer window
to(27.8); rec.final("yeah what about fuel");
to(31.5);                                 // the answer delivers (~30.6); its handoff is deferred 600ms
check("session stayed OPEN through the driver's answer (speech not used to close)", openBefore === true && Voice.isSessionOpen() === true);
check("the driver's answer during the offer window was CAPTURED (delivered)", delivered === 2);
check("no honest close fired on the answer's speechstart", !kinds().some(k => k.startsWith("close:honest")));
check("no close cue during the offer answer", count("cue") === 0);

// ── SCENARIO 9: both engines' restart churn is bounded (source of the fix) ─────
console.log("\n--- 9. both engines' restart churn is bounded (fix covers the basic engine too) ---");
check("convo: alive-time no longer resets the no-delivery ceiling (the leak is closed)",
  /if \(alive >= CONVO_HEALTHY_MS\) convoRestarts = 0;/.test(SRC) && !/alive >= CONVO_HEALTHY_MS\) \{ convoRestarts = 0; convoUndelivered = 0; \}/.test(SRC));
check("convo: genuine speech onset marks the cycle as progress, clears reply-pending AND resets the flip ceiling",
  /logEvent\('rec\.speechstart', 'convo'\); convoCycleHadSpeech = true; convoReplyPending = false; convoFlips = 0;/.test(SRC));
check("convo: the offer resume clears the oscillation guards for the answer",
  /convoSpeaking = false; if \(convoActive\) \{ convoFlips = 0; convoUndelivered = 0; convoLastState = ''; convoSetState\('listening'\)/.test(SRC));
check("basic: restart cap is heardSpeech-INDEPENDENT (time-since-progress window)",
  /heardSpeech && Date\.now\(\) - basicProgressAt > BASIC_CHURN_MS/.test(SRC));
check("basic: the progress timestamp resets on newly captured words",
  /if \(committedFinal\.length > _prevLen\) basicProgressAt = Date\.now\(\)/.test(SRC));
check("both ceilings are ~15s (convo cycles x ~5s cadence; basic churn window)",
  /const CONVO_MAX_CYCLES = 3;/.test(SRC) && /const BASIC_CHURN_MS = 15000;/.test(SRC));

// ── SCENARIO 10: the session silence clock must PAUSE during a long reply ──────
// Field id V9ZUTAZ (~38007s on): a session opened, the driver's turn delivered and
// classified, the app began a LONG reply — and 27s into its own TTS the session fired
// 'close silence' with the cue, mid-speech (tts.end 0.04s after). The silence clock,
// armed on the driver's last speech, kept counting through the reply. The 45s window
// was already ~18s down (AI latency before TTS) so a 30s reply blew past it.
// After the fix: no close can fire between tts.start and tts.end+tail; the session is
// still open at tts.end; it closes only on GENUINE driver silence AFTERWARDS.
console.log("\n--- 10. long reply inside a session: silence clock pauses, no mid-speech close (field V9ZUTAZ) ---");
Voice.closeSession("tap");   // scenario 8 left a session open; close it so openSession rebuilds a fresh recogniser (nulls convoRec)
fresh();
timers.length = 0;
Voice.onTranscript(() => { delivered++; });
base = clock.now;
Voice.openSession();
rec.speech();                             // 0s: driver starts — silence clock armed
to(1.0); rec.final("plan me a route to cooktown");
to(2.0); rec.final("plan me a route to cooktown for tonight");   // last speech ~2s -> hard close would fire ~47s
to(5.5);                                  // pause > CONVO_TURN_MS -> turn delivers (~4.8s), +600ms handoff -> ~5.4s
check("the driver's turn delivered and was classified (as in the field)", delivered === 1);
to(20.0);                                 // ~15s of AI latency composing a long brief — the window keeps ticking (would fire ~47s)
Voice.speak("Right, here's the run to Cooktown. It's a big day — roughly four and a half hours of driving broken into three legs, with the Palmer River Roadhouse the natural halfway pull-in, then Lakeland for fuel, and a final push up the range into Cooktown before dark.");
to(20.1); tts.start();
const closesAtSpeechStart = count("close");
to(35.0);                                 // ~15s into the 30s reply — WITHOUT the fix, 'close silence' fires here (~47s abs)
check("no close DURING the reply (silence clock is paused)", count("close") === closesAtSpeechStart, "closes=" + count("close"));
check("still speaking mid-reply — the reply was not truncated", Voice.state() === "speaking");
check("no anything-else offer interrupted the reply", count("offer") === 0);
to(50.1); tts.end();                      // 30-second reply ends
check("no close fired across the whole reply (tts.start..tts.end)", count("close") === closesAtSpeechStart);
check("session is STILL OPEN at tts.end (not killed mid-reply)", Voice.isSessionOpen() === true);
to(50.8); if (Voice.isSessionOpen()) rec.onstart();   // reopen after the tail; silence clock now armed FRESH
check("session open through the reopen tail, still no close", Voice.isSessionOpen() === true && count("close") === closesAtSpeechStart);
// genuine driver silence AFTER the reply -> the fresh 45s window finally closes it
to(97.0);                                 // > tts.end(50.1)+tail(0.6)+45s -> honest silence close
check("closes only after GENUINE driver silence afterwards", kinds().some(k => k === "close:silence"));
check("session is closed at the end", Voice.isSessionOpen() === false);
check("exactly one close cue for the whole session", count("cue") === 1);
// source-lock the fix: speak() clears BOTH session-lifetime timers as the reply begins
check("speak() pauses the silence + offer clocks while the app speaks",
  /convoSpeaking = true; convoStopRecogniser\(\);[\s\S]{0,600}?clearTimeout\(convoSilenceTimer\); clearTimeout\(convoOfferTimer\);/.test(SRC));

// ── SCENARIO 11: the compact in-row button names the feature idle ('🎙 Hands-free') and shows a
// short state WORD when live ('🎙 Listening'). The bar was folded into the input row, so the label
// is a state word only (colour rides in the class); the WORD must change between idle and open.
console.log("\n--- 11. in-row label: '🎙 Hands-free' idle, '🎙 Listening' when a session is open ---");
Voice.closeSession("tap");   // force setMicState('off') -> writes the idle label
const idleLabel = el("wakeBtn").textContent;
check("idle button names the feature '🎙 Hands-free'", idleLabel === "🎙 Hands-free", idleLabel);
fresh(); timers.length = 0;
Voice.openSession(); rec.onstart();   // session open, listening
const openLabel = el("wakeBtn").textContent;
check("open session reads the compact '🎙 Listening'", openLabel === "🎙 Listening" && Voice.isSessionOpen() && Voice.state() === "listening", openLabel);
check("the WORD changes between idle and open, not colour alone", idleLabel !== openLabel && /Hands-free/.test(idleLabel) && /Listening/.test(openLabel));
Voice.closeSession("tap");
check("returns to '🎙 Hands-free' idle after close", el("wakeBtn").textContent === "🎙 Hands-free");
check("Voice.canHandsFree() is exposed and true under a supporting engine", Voice.canHandsFree() === true);
// session behaviour unchanged is covered by scenarios 1–10 above (all still pass).

// three state labels retained (off / listening / speaking), via REAL transitions (setMicState is
// the sole writer; there is no separate status line to read the word off).
Voice.closeSession("tap");
check("state OFF → '🎙 Hands-free'", el("wakeBtn").textContent === "🎙 Hands-free", el("wakeBtn").textContent);
fresh(); timers.length = 0; Voice.openSession(); rec.onstart();
check("state LISTENING → '🎙 Listening'", el("wakeBtn").textContent === "🎙 Listening", el("wakeBtn").textContent);
Voice.speak("here are three camps near Innisfail"); tts.start();   // TTS onstart → 'speaking'
check("state SPEAKING → '🎙 Speaking'", el("wakeBtn").textContent === "🎙 Speaking" && Voice.state() === "speaking", el("wakeBtn").textContent);
tts.end(); Voice.closeSession("tap");

// ── SCENARIO 11b: dock compaction — the mic word lives ONLY in the button; the separate
// status line under the input row is GONE, and setMicState no longer paints #voiceStatus.
console.log("\n--- 11b. dock: single mic indicator, no separate #voiceStatus line ---");
const indexSrc = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
const speechSrc = fs.readFileSync(new URL("./speech.js", import.meta.url), "utf8");
check("index.html has NO voice-status element in the dock", !/id="voiceStatus"/.test(indexSrc) && !/class="voice-status"/.test(indexSrc));
check("setMicState no longer writes a #voiceStatus element", !/getElementById\(['"]voiceStatus['"]\)/.test(speechSrc));
// dock is ONE row: the full-width hands-free bar is gone; the button is folded INTO the input row.
check("no full-width .wake-bar row exists", !/class="wake-bar"/.test(indexSrc) && !/\.wake-bar\{/.test(indexSrc));
check("the Hands-free button lives inside the input row (before the textarea)", /<div class="input-row"[^>]*>\s*<button class="wake-word-btn[^>]*id="wakeBtn"/.test(indexSrc));
check("the Hands-free button is compact, not full-width", !/\.wake-word-btn\{[^}]*width:100%/.test(indexSrc) && /\.wake-word-btn\{[^}]*min-height:44px/.test(indexSrc));
// row order, left→right: Hands-free, one-shot mic, type box, reload (↺), send — the two VOICE
// controls sit together on the left, the TYPING controls together on the right.
const rowOrder = /id="wakeBtn"[\s\S]*?id="voiceBtn"[\s\S]*?id="userInput"[\s\S]*?id="resetBtn"[\s\S]*?id="sendBtn"/.test(indexSrc);
check("row order is Hands-free · mic · type box · reload · send", rowOrder);
check("the two voice controls are grouped on the left (mic immediately after Hands-free, before the type box)",
  /id="wakeBtn"[^>]*>[^<]*<\/button>\s*<button class="voice-btn" id="voiceBtn"[\s\S]*?<textarea id="userInput"/.test(indexSrc));
// one-shot mic behaviours intact: tap = Voice.toggleCapture, long-press = voice log.
check("one-shot mic tap = Voice.toggleCapture", /id="voiceBtn"[^>]*onclick="Voice\.toggleCapture\(\)"/.test(indexSrc));
check("one-shot mic long-press opens the voice log (_vlAttach voiceBtn)", /_vlAttach\(document\.getElementById\('voiceBtn'\), true\)/.test(indexSrc));
check("one-shot mic tap target ~44px", /\.voice-btn\{[^}]*width:44px;height:44px/.test(indexSrc));
check("one-shot capture also reachable from the home mic", /function homeMic\(\)[\s\S]{0,220}toggleCapture\(\)/.test(indexSrc));
// ── constant-height dock (field 31 Jul: label switches reflowed the row + wrapped the placeholder,
// growing the dock over the cards). Fix = fixed button width + single-line placeholder. Measured
// headless @380px: dock height IDENTICAL 73px across Hands-free/Listening/Recording/Speaking/Thinking;
// button width constant 116px, no clip; "Type here…" would wrap without nowrap but stays one line with it.
const wakeRule = (indexSrc.match(/\.wake-word-btn\{[^}]*\}/) || [""])[0];
check("Hands-free button has a FIXED width (flex:0 0 116px) → label changes can't reflow the row",
  /flex:0 0 116px/.test(wakeRule) && !/flex-shrink:0;padding:0 12px/.test(wakeRule));
const inputRule = (indexSrc.match(/#userInput\{[^}]*\}/) || [""])[0];
check("type box placeholder can't wrap: white-space:nowrap + text-overflow:ellipsis on #userInput",
  /white-space:nowrap/.test(inputRule) && /text-overflow:ellipsis/.test(inputRule));
// point 4 (bottom padding = dock height) was DROPPED by decision: the dock is a non-overlapping flex
// sibling of .chat-area, so the chat viewport already ends at the dock's top — no overlay to clear.
check("no dock-sized bottom padding was added to .chat-area (dock is a flex sibling, not an overlay)",
  /\.chat-area\{[^}]*padding:10px 14px[^}]*\}/.test(indexSrc) && !/\.chat-area\{[^}]*padding-bottom:7[0-9]px/.test(indexSrc));
// point 1 (wider card buttons): the two controls are flex:1 with no per-button side margin,
// so their combined width == the card's inner width by construction (measured headless: 372/372).
const btnRule = (indexSrc.match(/\.camp-btn\{[^}]*\}/) || [""])[0];
check("both card buttons are flex:1 → pair spans the card's full inner width", /flex:1/.test(btnRule) && !/margin-(left|right|inline)/.test(btnRule));
check("card side padding trimmed (8px → 5px) so the button pair reaches nearer the card edge", /\.camp-card\{[^}]*padding:5px 5px/.test(indexSrc));

// ── SCENARIO 12: 9XJ9UWR 145-151s — a driver speaking continuously across THREE engine
// restarts is NEVER closed on; the accumulated turn survives the restarts and delivers on
// the real pause. Progress = a genuine speechstart, so each result-bearing cycle clears the
// no-progress reopen ceiling. (Fixed: before, three restarts inside one utterance closed
// the session honestly + cued mid-speech in ~8s.)
console.log("\n--- 12. 9XJ9UWR: driver speaking across 3 engine restarts stays open + delivers ---");
fresh(); timers.length = 0;
Voice.openSession(); rec.onstart();
// cycle 1: driver speaks, engine drops mid-utterance BEFORE the 2800ms end-of-turn pause
rec.speech(); rec.final("are there any"); advance(1500); rec.end();
advance(300); rec.onstart();          // restart 1 — cycle 1 saw speech -> must NOT count
// cycle 2: driver still going (the log's speechstart ~1.2s after the first onend)
rec.speech(); rec.final("are there any campsites"); advance(1500); rec.end();
advance(300); rec.onstart();          // restart 2 — still progress
// cycle 3: driver finishes the phrase
rec.speech(); rec.final("are there any campsites near innisfail"); advance(1500); rec.end();
advance(300); rec.onstart();          // restart 3 — still progress
check("NEVER closed while the driver spoke across the 3 restarts", !kinds().some(k => k.startsWith("close")));
check("no cue fired mid-speech", count("cue") === 0);
check("speechstart cycles logged as progress, not an accumulating count", count("reopen") >= 1 && kinds().includes("reopen:progress"));
// the driver finally PAUSES -> the accumulated turn delivers, session stays open
advance(2800); advance(600);
check("the whole accumulated turn delivered after the real pause", delivered === 1);
check("no honest close ever fired on the live utterance", !kinds().some(k => k.startsWith("close:honest")));
check("session still OPEN after delivery", Voice.isSessionOpen() === true);
Voice.closeSession("tap");

// A speechstart cycle clears the ceiling; a truly-empty cycle still climbs it. Contrast
// directly: ambient/empty reopens (no speechstart) STILL close (scenarios 3/4/6/7 assert
// this at length) — here we just confirm the ceiling is intact when speech is absent.
console.log("\n--- 12b. empty (no-speechstart) reopens still close at the ceiling ---");
fresh(); timers.length = 0;
Voice.openSession();
let closed12 = false;
for (let i = 0; i < 12 && !closed12; i++) { rec.onstart(); rec.end(); advance(300); closed12 = kinds().some(k => k.startsWith("close:")); }
check("a no-speechstart restart loop still closes honestly", closed12 && delivered === 0);

// ── SCENARIO 13 (addendum 9XJ9UWR): a ceiling (honest) close ABORTS the recogniser and
// fully releases — nothing left holding the mic — and a fresh session opens cleanly after.
// (Confirms the post-close one-shot deadness in the field is not a frontend cleanup leak.)
console.log("\n--- 13. ceiling close aborts the recogniser + fully releases (addendum) ---");
fresh(); timers.length = 0;
Voice.openSession(); rec.onstart();
const stopsBefore = H.stopped;
let closed13 = false;
for (let i = 0; i < 12 && !closed13; i++) { rec.onstart(); rec.end(); advance(300); closed13 = kinds().some(k => k.startsWith("close:honest")); }
check("closed honestly at the ceiling", closed13);
check("the recogniser was aborted/stopped on close (mic released)", H.stopped > stopsBefore);
check("session fully released: state off, not open", Voice.state() === "off" && Voice.isSessionOpen() === false);
const recBefore = H.rec;
Voice.openSession();
check("a fresh session opens afterward on a NEW recogniser instance", H.rec !== recBefore && Voice.isSessionOpen() === true);
Voice.closeSession("tap");

// ── SCENARIO 14: 4D6EDK9 24755-24809s — a delivered turn, then a ~14s compose gap while
// the app builds the camps answer, then the reply. The empty mic cycles DURING the compose
// are the app's thinking, not idle driver churn, so the no-progress ceiling must NOT count
// them (before the fix it ran to 3 and closed honest at 24793.71, the reply playing to a
// dead session). After the reply + tail, GENUINELY-idle driver cycles still close the ceiling.
console.log("\n--- 14. 4D6EDK9: a 14s compose gap after a delivered turn must NOT close; idle after the reply still does ---");
fresh(); timers.length = 0;
Voice.openSession(); rec.onstart();
// the driver's turn: speak, pause -> DELIVER (~2800ms), +600ms send handoff
rec.speech(); rec.final("are there any campsites at innisfail");
advance(2800);                 // end-of-turn pause -> convoDeliverTurn -> reply pending
advance(600);                  // deliver->send handoff -> onTranscript
check("the driver's turn delivered", delivered === 1);
// the app now composes the camps answer for ~14s (busy). The mic keeps cycling EMPTY —
// no speechstart — but these are the app thinking, so they must NOT count toward the ceiling.
busyFlag = true;
for (let i = 0; i < 5; i++) { rec.onstart(); advance(2500); rec.end(); advance(300); }   // ~14s of empty (healthy-length) cycles
check("NO close during the ~14s compose gap", !kinds().some(k => k.startsWith("close")), kinds().join(","));
check("no cue fired while thinking", count("cue") === 0);
// compose done — the reply plays and ends
busyFlag = false;
Voice.speak("Three parks near Innisfail, closest first.");
tts.start();
advance(1500); tts.end();
check("session STILL OPEN when the reply ends (not closed by the compose gap)", Voice.isSessionOpen() === true);
check("no close fired anywhere between deliver and reply-end", !kinds().some(k => k.startsWith("close")));
advance(700);                  // reopen after the tail (CONVO_TTS_TAIL_MS)
check("open through the reopen tail; the ceiling was reset for a full fresh grace", Voice.isSessionOpen() === true && !kinds().some(k => k.startsWith("close")));
// NOW it is genuinely the driver's turn — three genuinely-idle cycles still close the ceiling.
let closed14 = false;
for (let i = 0; i < 6 && !closed14; i++) { rec.onstart(); advance(2500); rec.end(); advance(300); closed14 = kinds().some(k => k.startsWith("close:honest")); }
check("post-reply GENUINELY-idle cycles STILL close at the ceiling (churn protection intact)", closed14);
Voice.closeSession("tap");
// source-lock the fix: the no-progress ceiling is suspended while a reply is pending / thinking / speaking
check("no-progress ceiling suspended across deliver -> reply-finished",
  /if \(convoReplyPending \|\| convoSpeaking \|\| _isBusy\(\)\) return false;/.test(SRC) && /convoReplyPending = true;/.test(SRC));

console.log("\n" + (ok ? "ALL PASS" : "FAILURES ABOVE"));
process.exit(ok ? 0 : 1);
