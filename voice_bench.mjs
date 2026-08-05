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
// rAF is queued (was a drop) so a CLOUD-RIG scenario can pump the VAD tick loop against a
// scripted level-track. Nothing else ever pumps the queue, so every non-rig scenario sees
// exactly the old behaviour (callbacks parked, never fired).
const rafQueue = [];
const fakeRAF = (fn) => { rafQueue.push(fn); return 0; };
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
// Extended for the CLOUD RIG: resume/close/state + analyser + stream source, so the REAL
// armRecordingSilence/finishCloudCapture verified-analyser logic runs against it. The analyser
// reads the rig's scripted level at call time (RIG.level — 0 silence, e.g. 40 speech). All
// additions are additive: the cue scenarios only ever used createOscillator/createGain.
const MockAudioCtx = class {
  constructor(){ this.currentTime = 0; this.destination = {}; this.state = "suspended"; }
  resume(){ this.state = "running"; return Promise.resolve(); }
  close(){ this.state = "closed"; }
  createOscillator(){ return { type:"", frequency:{ setValueAtTime(){} }, connect(){}, start(){}, stop(){} }; }
  createGain(){ return { gain:{ setValueAtTime(){}, exponentialRampToValueAtTime(){} }, connect(){} }; }
  createMediaStreamSource(){ return { connect(){} }; }
  createAnalyser(){ return { fftSize: 512, connect(){}, getByteTimeDomainData(buf){ buf.fill(128); buf[0] = 128 + (RIG.level || 0); } }; }
};
const mockWindow = { speechSynthesis: synth, SpeechRecognition: MockSR, webkitSpeechRecognition: MockSR, AudioContext: MockAudioCtx, webkitAudioContext: MockAudioCtx };
const mockNavigator = { userAgent: "bench", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) }, permissions: { query: async () => ({ state: "granted" }) } };

// ── CLOUD-EARS RIG (BENCH-RIG ticket) ─────────────────────────────────────────
// Fake MediaRecorder + a scripted analyser level-track + a scripted fetch('/transcribe'),
// so the REAL cloud path (startCloudCapture → VAD → finishCloudCapture → transcribeBlob →
// deliverTranscript) runs end-to-end with zero hardware and zero network. SCOPED on purpose:
// RIG.enable() installs MediaRecorder on BOTH window and the bare global (speech.js checks
// window.MediaRecorder but constructs a bare `new MediaRecorder`), flipping cloudEarsSupported()
// true only inside a rig scenario; RIG.disable() restores the no-MediaRecorder world that
// scenarios 15/17 (basic one-shot path) depend on. The fetch mock is global but THROWS when
// nothing is scripted, so no other scenario can silently hit a network path.
class MockMediaRecorder {
  constructor(stream, opts) { this.stream = stream; this.mimeType = (opts && opts.mimeType) || "audio/webm"; this.state = "inactive"; this.ondataavailable = null; this.onstop = null; RIG.recorder = this; }
  static isTypeSupported() { return true; }
  start() { this.state = "recording"; RIG.starts++; }
  stop() { this.state = "inactive"; RIG.stops++; if (this.ondataavailable) this.ondataavailable({ data: RIG.audio }); if (this.onstop) this.onstop(); }
}
const RIG = {
  recorder: null, level: 0, starts: 0, stops: 0,
  audio: new Blob(["x".repeat(4096)], { type: "audio/webm" }),   // a plausible utterance blob (> the 1024b floor)
  transcripts: [],   // scripted /transcribe outcomes, consumed in order: a string resolves {text}; {fail:'…'} throws; {status:500} HTTP-fails
  fetches: [],       // every fetch the module made: { url, opts }
  enable()  { mockWindow.MediaRecorder = MockMediaRecorder; globalThis.MediaRecorder = MockMediaRecorder; },
  disable() { delete mockWindow.MediaRecorder; delete globalThis.MediaRecorder; this.recorder = null; this.level = 0; },
  reset()   { this.recorder = null; this.level = 0; this.starts = 0; this.stops = 0; this.transcripts.length = 0; this.fetches.length = 0; },
  // Drive the VAD tick loop with a level-track: one entry per tick (0 = silence, ~40 = speech),
  // e.g. [...Array(20).fill(0), ...Array(15).fill(40), ...Array(30).fill(0)]. Each tick fires the
  // queued rAF callback(s) at the CURRENT clock, then advances tickMs and lets microtasks settle.
  async pump(levels, tickMs = 100) {
    for (const lvl of levels) {
      this.level = lvl;
      rafQueue.splice(0).forEach(fn => fn());
      advance(tickMs);
      await Promise.resolve();
    }
  },
  settle() { return new Promise(r => setImmediate(r)); },   // drain ALL pending microtask chains (real macrotask)
};
globalThis.fetch = async (url, opts) => {
  RIG.fetches.push({ url: String(url), opts });
  const next = RIG.transcripts.shift();
  if (next === undefined) throw new Error("bench fetch: nothing scripted for " + url);
  if (next && next.fail) throw new Error(next.fail);
  if (next && next.status) return { ok: false, status: next.status, json: async () => ({ error: "scripted " + next.status }) };
  return { ok: true, status: 200, json: async () => ({ text: next }) };
};
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
const countCue = (which) => Voice.getLog().filter(e => e.kind === "cue" && e.detail === which).length;   // open vs close cues
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
check("exactly ONE open cue at session open (the driver's turn began)", countCue("open") === 1);
check("no close cue during a normal (non-closing) turn", countCue("close") === 0);
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
check("close cue fired exactly once (a real honest close)", countCue("close") === 1);
check("churn added NO cues: exactly one OPEN cue at session start, ZERO per restart", countCue("open") === 1);

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
  check("...close cue exactly once", countCue("close") === 1);
  check("...one open cue at start, none from the ambient churn", countCue("open") === 1);
}

// ── SCENARIO 5: the four close paths — each closes, cue once, state off ───────
console.log("\n--- 5. four close paths ---");
for (const reason of ["tap", "phrase", "silence", "honest"]) {
  fresh();
  Voice.openSession(); rec.onstart();
  Voice.closeSession(reason);
  check(reason + ": one open cue at start + one close cue + state off", countCue("open") === 1 && countCue("close") === 1 && Voice.state() === "off");
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
check("replay reproduces exactly one close cue (+ one open at start, none per restart)", countCue("close") === 1 && countCue("open") === 1);
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
check("exactly one close cue (not one per restart)", countCue("close") === 1);
check("open cues ONLY at genuine turn-starts (session open + reply-end reopen = 2), none from the ~5s churn", countCue("open") === 2);
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
check("no CLOSE cue during the offer answer (the session never closed)", countCue("close") === 0);
check("an open cue fired at each genuine turn-start: session open + reply-end reopen + offer reopen = 3", countCue("open") === 3);

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
check("no OPEN cue during the reply — the cue is SILENT while the app speaks (TTS/thinking)", countCue("open") === 1, "open=" + countCue("open"));
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
check("exactly one close cue for the whole session", countCue("close") === 1);
check("open cues only at the two turn-starts (session open + the post-reply reopen), none mid-reply", countCue("open") === 2);
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
// dock polish: placeholder shortened to "Type…" (fits the 64px box on one line; nowrap keeps it single).
check("type box placeholder is \"Type…\" (not the longer \"Type here…\")", /placeholder="Type…"/.test(indexSrc) && !/placeholder="Type here…"/.test(indexSrc));
// ── SINGLE-ROW cards (field 31 Jul): the pin button IS the card — one row, no "Navigate" word, an
// icon-only 📞 call button beside it. Free = green, full-width pin, FREE tag on the row, note under.
// Measured headless @380px: pin 44px tall, call 44×44; commercial-with-call row ~49px, note-cards ~64px;
// ~13 rows fit the ~647px chat budget (800 − 42 − 38 − 73). The old .camp-btn/.camp-actions are gone.
const pinRule = (indexSrc.match(/\.camp-pin\{[^}]*\}/) || [""])[0];
check("the pin button IS the card — flex:1, ~44px tap target", /flex:1/.test(pinRule) && /min-height:44px/.test(pinRule));
check("the call control is an icon-only ≥44px square", /\.camp-call\{[^}]*width:44px[^}]*height:44px/.test(indexSrc));
check("free pin is full-width green (its own row, one control)", /\.camp-card\.free \.camp-pin\{background:var\(--green\)/.test(indexSrc));
check("the FREE tag rides on the row (pin)", /\.camp-free-tag\{/.test(indexSrc));
check("the old multi-element card CSS is gone (.camp-btn / .camp-actions / .camp-card-head)", !/\.camp-btn\{/.test(indexSrc) && !/\.camp-actions\{/.test(indexSrc) && !/\.camp-card-head\{/.test(indexSrc));
check("no card pin label carries the word 'Navigate'", !/camp-pin-name['"\s].*Navigate/.test(indexSrc) && !/\.textContent = '📍 Navigate'/.test(indexSrc));

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
check("open cue only at session start — the 3 mid-speech restarts add ZERO cues", countCue("open") === 1);
check("no close cue mid-speech", countCue("close") === 0);
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
check("no NEW cue while thinking — the only open cue was at session start, none from the compose-gap cycles", countCue("open") === 1 && countCue("close") === 0);
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

// ── SCENARIO 15: ONE-SHOT capture start fires the OPEN cue once ───────────────
// The third turn-start trigger (alongside session open + reply-end reopen): a one-shot mic tap.
// The bench has no MediaRecorder, so startListening() takes the BASIC Web-Speech path; its
// onstart fires the RISING cue. Basic restarts continuously — the openCued guard caps it at one.
console.log("\n--- 15. one-shot capture start: one open cue, none from the basic restart churn ---");
Voice.closeSession("tap");                     // make sure no session owns the mic
fresh(); timers.length = 0;
Voice.toggleCapture();                          // one-shot tap → startListening() (async granted-mic gate)
for (let i = 0; i < 6; i++) await Promise.resolve();   // flush the permission microtasks so the recogniser is built
rec.onstart();                                  // the one-shot mic actually opens → RISING cue
check("one-shot start fired exactly ONE open cue", countCue("open") === 1, "open=" + countCue("open"));
check("one-shot mic is 'recording' (a tap SENDS)", Voice.state() === "recording");
rec.end(); rec.onstart(); rec.end(); rec.onstart();   // basic restart churn — re-enters 'recording' each time
check("basic restart churn adds NO further open cues (openCued caps it)", countCue("open") === 1, "open=" + countCue("open"));
check("no close cue during one-shot capture", countCue("close") === 0);
// source-lock: the open cue is wired at BOTH one-shot start points (cloud recorder start + basic onstart)
check("open cue wired at the one-shot cloud start", /setMicState\('recording'\);    \/\/ one-shot cloud capture is live[\s\S]{0,80}?convoOpenCue\(\)/.test(SRC));
check("open cue wired at the one-shot basic onstart", /recognition\.onstart = \(\) => \{[^}]*setMicState\('recording'\); convoOpenCue\(\);/.test(SRC));

// ── SCENARIO 16: MELODIC cues (A) — rising open, the same notes falling for close, distinct ──
console.log("\n--- 16. melodic cues: rising open, falling close, distinct sequences ---");
const openNotes = JSON.parse(SRC.match(/const CUE_OPEN_NOTES\s*=\s*(\[[^\]]*\])/)[1]);
const closeNotes = JSON.parse(SRC.match(/const CUE_CLOSE_NOTES\s*=\s*(\[[^\]]*\])/)[1]);
check("open cue is a three-note sequence", openNotes.length === 3);
check("close cue is a three-note sequence", closeNotes.length === 3);
check("open notes strictly RISE", openNotes.every((f, i) => i === 0 || f > openNotes[i - 1]), JSON.stringify(openNotes));
check("close notes strictly FALL", closeNotes.every((f, i) => i === 0 || f < closeNotes[i - 1]), JSON.stringify(closeNotes));
check("close is the open sequence reversed (same notes, opposite direction)", JSON.stringify(closeNotes) === JSON.stringify([...openNotes].reverse()));
check("both cues route through the shared melody player (triggers unchanged)", /playCueMelody\(CUE_OPEN_NOTES\)/.test(SRC) && /playCueMelody\(CUE_CLOSE_NOTES\)/.test(SRC) && /function playCueMelody\(freqs\)/.test(SRC));
check("the cue GUARDS are unchanged (openCued + micState gate on open; convoCued on close)", /function convoOpenCue\(\) \{\s*if \(openCued\) return;[\s\S]{0,140}micState !== 'listening'/.test(SRC) && /function convoCloseCue\(\) \{\s*if \(convoCued\) return;/.test(SRC));

// ── SCENARIO 17: CANCEL a capture (B) ─────────────────────────────────────────
console.log("\n--- 17. cancel: session survives + reopens listening; one-shot bins + closes; spoken 'scratch that' routes nowhere ---");
// (a) SESSION tap-cancel mid-turn: nothing delivered, session stays open, back to a fresh listening turn + one open cue
fresh(); timers.length = 0;
Voice.openSession(); rec.onstart();
rec.speech(); rec.final("find me a serv");         // driver gets muddled mid-utterance
const openBeforeCancel = countCue("open");
Voice.cancelCapture();                              // TAP the red ✕
check("session cancel is logged", kinds().includes("cancel:tap-session"));
check("cancel delivered NOTHING", delivered === 0);
check("session STAYS OPEN after a cancel", Voice.isSessionOpen() === true);
check("session returned to a fresh LISTENING turn", Voice.state() === "listening");
check("the fresh turn earns exactly ONE open cue", countCue("open") === openBeforeCancel + 1);
rec.onstart(); rec.speech(); rec.final("cheapest fuel"); advance(2800); advance(600);
check("a clean utterance AFTER the cancel delivers normally (muddled turn is gone)", delivered === 1);
Voice.closeSession("tap");

// (b) SPOKEN cancel: a transcript ENDING "scratch that" routes nowhere; mid-sentence does NOT trigger
fresh(); timers.length = 0;
Voice.openSession(); rec.onstart();
rec.speech(); rec.final("find fuel scratch that"); advance(2800); advance(600);
check("a transcript ending 'scratch that' is binned — nothing routed", delivered === 0);
check("spoken cancel is logged", kinds().includes("cancel:spoken"));
check("session survives the spoken cancel, back to listening", Voice.isSessionOpen() === true && Voice.state() === "listening");
Voice.closeSession("tap");
fresh(); timers.length = 0;
Voice.openSession(); rec.onstart();
rec.speech(); rec.final("cancel that booking then find fuel"); advance(2800); advance(600);
check("mid-sentence 'cancel that' does NOT trigger — it routes normally", delivered === 1);
Voice.closeSession("tap");

// (c) ONE-SHOT tap-cancel: send arrow → ✕ while recording, bins the capture, mic closes, arrow reverts
fresh(); timers.length = 0;
Voice.toggleCapture();
for (let i = 0; i < 6; i++) await Promise.resolve();
rec.onstart();
check("the send arrow becomes ✕ while a capture is recording", el("sendBtn").textContent === "✕");
Voice.cancelCapture();
check("one-shot cancel is logged", kinds().includes("cancel:tap-oneshot"));
check("one-shot cancel delivered NOTHING", delivered === 0);
check("the mic CLOSES after a one-shot cancel", Voice.state() === "off");
check("the send arrow REVERTS to ➤ outside recording", el("sendBtn").textContent === "➤");
check("sendOrCancel branches on a recording state (index.html)", /Voice\.state\(\) === 'recording'.*Voice\.cancelCapture\(\)/.test(fs.readFileSync(new URL("./index.html", import.meta.url), "utf8")));

// ── SCENARIO 18: CLOUD RIG (BENCH-RIG ticket) — the rig drives the REAL one-shot cloud
// path end-to-end: tap → MediaRecorder → analyser level-track → VAD silence stop →
// scripted /transcribe → deliverTranscript, events asserted in the ring buffer. This
// proves the mocks against the EXISTING path BEFORE any session engine is built on them.
console.log("\n--- 18. cloud rig: one-shot → VAD silence stop → transcribe → deliver ---");
// (a) the happy path: speech, then quiet — VAD ends the turn, Whisper text delivers once
fresh(); timers.length = 0; rafQueue.length = 0; RIG.reset(); RIG.enable();
Voice.onTranscript(() => { delivered++; });
RIG.transcripts.push("caravan parks in Cardwell");
Voice.toggleCapture();                       // one-shot tap → startListening → the CLOUD path
await RIG.settle();                          // permission gate + getUserMedia + recorder start + analyser resume
check("rig recorder created and RECORDING on the real path", !!RIG.recorder && RIG.recorder.state === "recording" && RIG.starts === 1);
check("mic state 'recording', ✕ showing, ONE open cue", Voice.state() === "recording" && el("sendBtn").textContent === "✕" && countCue("open") === 1);
await RIG.pump([...Array(8).fill(40), ...Array(32).fill(0)]);   // ~0.8s speech, then 3.2s quiet → the 2.8s VAD cut fires
await RIG.settle();                          // onstop → finishCloudCapture → fetch → deliverTranscript
check("VAD silence STOPPED the recorder (once)", RIG.recorder.state === "inactive" && RIG.stops === 1);
check("exactly ONE upload went to /transcribe", RIG.fetches.length === 1 && /transcribe$/.test(RIG.fetches[0].url));
check("ring buffer: deliver:cloud:silence logged", kinds().includes("deliver:cloud:silence"));
check("state landed on thinking after the transcript", Voice.state() === "thinking");
advance(700);                                // the 600ms deliver handoff
check("delivered exactly ONCE to the app", delivered === 1);
check("no close cue (one-shot — no session opened or closed)", countCue("close") === 0);
// (b) a verified-silent window: analyser ran, no voice — discarded LOCALLY, nothing uploaded
fresh(); timers.length = 0; rafQueue.length = 0; RIG.reset();
Voice.onTranscript(() => { delivered++; });
Voice.toggleCapture();
await RIG.settle();
await RIG.pump(Array(10).fill(0));           // a silent second — the VAD never arms (no speech yet)
Voice.toggleCapture();                       // driver taps to send anyway
await RIG.settle();
check("a verified-silent capture is discarded locally — NOTHING uploaded", RIG.fetches.length === 0 && delivered === 0);
check("the silent discard closed the mic", Voice.state() === "off");
// (c) a scripted /transcribe FAILURE: the turn falls back to Web Speech, honestly
fresh(); timers.length = 0; rafQueue.length = 0; RIG.reset(); H.started = 0;
Voice.onTranscript(() => { delivered++; });
RIG.transcripts.push({ fail: "network down" });
Voice.toggleCapture();
await RIG.settle();
await RIG.pump([...Array(8).fill(40), ...Array(32).fill(0)]);
await RIG.settle();
check("the scripted failure was consumed (one fetch attempt made)", RIG.fetches.length === 1);
check("fallback: the BASIC recogniser took the turn, nothing false-delivered", H.started >= 1 && delivered === 0);
Voice.cancelCapture();                       // tidy: bin the fallback capture, mic off
RIG.disable(); timers.length = 0; rafQueue.length = 0;

// ── SCENARIO 19: VAD-UNIT — vadMonitor extracted and unit-driven by the rig ────
// The one reusable level-watcher: defaults byte-identical to the old inline loop
// (fixed >6 peak, no hysteresis, no floor); hysteresis + adaptive floor prove out
// for the session engine. Scenario 18 (above) already re-proves the REAL one-shot
// path end-to-end THROUGH vadMonitor — this drives the unit directly.
console.log("\n--- 19. VAD-unit: defaults byte-identical; hysteresis; adaptive floor; alive/stop ---");
function exFn(n) { let a = SRC.indexOf("function " + n); if (a < 0) throw new Error("nf " + n); let d = 0, s = false; for (let j = SRC.indexOf("{", a); j < SRC.length; j++) { if (SRC[j] === "{") { d++; s = true; } else if (SRC[j] === "}") { d--; if (s && d === 0) return SRC.slice(a, j + 1); } } }
const vadT = new Function("requestAnimationFrame", "Date", "REC_SILENCE_MS", "return " + exFn("vadMonitor"))(fakeRAF, FakeDate, 2800);
const vctx = () => { const c = new MockAudioCtx(); c.state = "running"; return c; };
const stream0 = {};
async function runVad(opts, track, tickMs = 100) {
  rafQueue.length = 0;
  const got = { speech: 0, quiet: 0, quietMs: 0 };
  const mon = vadT(stream0, vctx(), Object.assign({ onSpeech: () => got.speech++, onQuiet: (ms) => { got.quiet++; got.quietMs = ms; } }, opts));
  await RIG.pump(track, tickMs);
  return { got, mon };
}
// (a) defaults: strictly >6 — level 6 never counts as speech, level 7 does
let r19 = await runVad({ quietMs: 2800 }, Array(10).fill(6));
check("defaults: level 6 is NOT speech (strict >6, as before)", r19.got.speech === 0);
r19 = await runVad({ quietMs: 2800 }, Array(3).fill(7));
check("defaults: level 7 IS speech", r19.got.speech > 0);
// (b) the 2.8s quiet cut fires ONCE after speech; shorter quiet never fires
r19 = await runVad({ quietMs: 2800 }, [...Array(8).fill(40), ...Array(32).fill(0)]);
check("speech then 3.2s quiet → onQuiet fires exactly ONCE at the 2.8s cut", r19.got.quiet === 1 && r19.got.quietMs >= 2800);
r19 = await runVad({ quietMs: 2800 }, [...Array(8).fill(40), ...Array(20).fill(0)]);
check("quiet shorter than the cut (2.0s) NEVER ends the turn", r19.got.quiet === 0);
check("quiet before ANY speech never fires (driver still thinking)", (await runVad({ quietMs: 2800 }, Array(40).fill(0))).got.quiet === 0);
// (c) hysteresis: hold below onset — a soft trailing level sustains the utterance it could never start
r19 = await runVad({ quietMs: 2800, onset: 20, hold: 5 }, Array(15).fill(10));
check("hysteresis: level 10 never STARTS speech when onset is 20", r19.got.speech === 0);
r19 = await runVad({ quietMs: 2800, onset: 20, hold: 5 }, [...Array(5).fill(40), ...Array(35).fill(10)]);
check("hysteresis: after onset, a soft 10 SUSTAINS the utterance (no quiet cut in 3.5s)", r19.got.quiet === 0 && r19.got.speech >= 5);
r19 = await runVad({ quietMs: 2800, onset: 20, hold: 5 }, [...Array(5).fill(40), ...Array(10).fill(10), ...Array(32).fill(0)]);
check("hysteresis: real quiet after the soft tail still ends the turn once", r19.got.quiet === 1);
// (d) adaptive floor: steady cab drone never reads as speech; a real burst above it does
r19 = await runVad({ quietMs: 2800, adaptive: true }, Array(20).fill(10));
check("adaptive: steady ambient 10 never triggers speech (floor absorbed it)", r19.got.speech === 0);
r19 = await runVad({ quietMs: 2800, adaptive: true }, [...Array(8).fill(10), ...Array(5).fill(40)]);
check("adaptive: a genuine burst OVER the floor still triggers speech", r19.got.speech > 0);
// (e) alive() false stops the loop; (f) stop() halts callbacks
let aliveFlag = true;
r19 = await runVad({ quietMs: 2800, alive: () => aliveFlag }, Array(3).fill(40));
aliveFlag = false;
await RIG.pump(Array(5).fill(40));
check("alive() false stops the loop (no further speech callbacks)", r19.got.speech === 3);
r19 = await runVad({ quietMs: 2800 }, Array(3).fill(40));
r19.mon.stop();
await RIG.pump(Array(5).fill(40));
check("stop() halts the monitor (no further callbacks)", r19.got.speech === 3);
// (g) the one-shot wrapper delegates with today's exact config; the stale 1.5s comment is gone
check("armRecordingSilence delegates to vadMonitor (quietMs: REC_SILENCE_MS, onQuiet → stopCloudCapture)", /vadMonitor\(mediaStream, recAudioCtx, \{[\s\S]{0,400}quietMs: REC_SILENCE_MS[\s\S]{0,400}onQuiet: \(\) => \{ cloudEndReason = 'silence'; stopCloudCapture\(true\); \}/.test(SRC));
check("one-shot config passes NO onset/hold/adaptive (defaults = the old fixed thresholds)", !/vadMonitor\(mediaStream, recAudioCtx, \{[\s\S]{0,400}(onset|hold|adaptive):/.test(SRC));
check("recAnalyserOn is set only AFTER the wiring succeeded (verified-silent discard stays safe)", /\}\);\n    recAnalyserOn = true;/.test(SRC));
check("the stale '~1.5s' comment is gone from the silence-cut header", !/End the turn after ~1\.5s/.test(SRC) && /End the turn after ~2\.8s of quiet \(REC_SILENCE_MS/.test(SRC));
rafQueue.length = 0; timers.length = 0;

// ── SCENARIO 20: CS-SKELETON — the cloud session, gated OFF in the shipped build ─
// (a) the OTHER path untouched: a NON-Android device (the primary instance) with
// MediaRecorder present still gets the Web-Speech session — the pick, not the flag,
// routes it. (b) the ANDROID instance: held stream, per-turn windows, VAD
// segmentation, upload → deliver, close.
console.log("\n--- 20. CS-skeleton: flag-off byte-identical; flag-on session end-to-end ---");
check("the shipped flag is ON (const CS_ENABLED = true — step 9, the Android field trial)", /const CS_ENABLED = true;/.test(SRC));
check("cs state is fully ISOLATED from the one-shot cloud globals", !/\bmediaRecorder\b|\brecChunks\b|\brecVoiced\b|\brecAnalyserOn\b|\bcloudActive = /.test(exFn("csStartWindow") + exFn("csEndWindow") + exFn("csCloseSession")));
// (a) flag off: MediaRecorder available, yet openSession = the Web-Speech session
fresh(); timers.length = 0; rafQueue.length = 0; RIG.reset(); RIG.enable();
Voice.openSession();
check("non-Android: openSession runs the WEB-SPEECH session (open:session, a recogniser)", kinds().includes("open:session") && H.rec !== null);
check("non-Android: no cs.* event ever fires (engine:webspeech logged instead)", !kinds().some(k => k.startsWith("cs.")) && kinds().includes("engine:webspeech"));
Voice.closeSession("tap");
// (b) flag ON: a second instance from the SAME source, only the flag flipped
let gumCalls = 0, trackStops = 0;
mockNavigator.mediaDevices.getUserMedia = async () => { gumCalls++; return { getTracks: () => [{ stop() { trackStops++; } }] }; };
const loader2 = new Function(
  "window", "document", "navigator", "SpeechSynthesisUtterance", "setTimeout", "clearTimeout", "requestAnimationFrame", "Date", "console",
  SRC.replace("const CS_ENABLED = false;", "const CS_ENABLED = true;") + "\nreturn window.Voice;"
);
// The cs instance runs as ANDROID (the CS-SEAM engine pick gates on it); it SHARES
// mockNavigator's mediaDevices object, so scenario-level getUserMedia swaps apply to both.
const mockNavigatorAndroid = { userAgent: "Linux; Android 14; bench", mediaDevices: mockNavigator.mediaDevices, permissions: mockNavigator.permissions };
const Voice2 = loader2(mockWindow, mockDocument, mockNavigatorAndroid, MockUtt, fakeSetTimeout, fakeClearTimeout, fakeRAF, FakeDate, silentConsole);
let delivered2 = 0;
Voice2.onTranscript(() => { delivered2++; });
Voice2.setBusyGetter(() => false);
const kinds2 = () => Voice2.getLog().map(e => e.kind + (e.detail ? ":" + e.detail : ""));
const cue2 = (w) => Voice2.getLog().filter(e => e.kind === "cue" && e.detail === w).length;   // cloud-engine cue counts (CS-STATUS-CUES)
Voice2.clearLog(); rafQueue.length = 0; RIG.reset();
Voice2.openSession();
await RIG.settle();
check("flag ON: cs.open + held stream (ONE getUserMedia) + first window recording", kinds2().includes("cs.open:session") && gumCalls === 1 && !!RIG.recorder && RIG.recorder.state === "recording" && RIG.starts === 1);
check("flag ON: session open, state listening", Voice2.isSessionOpen() === true && Voice2.state() === "listening");
check("CUES: ONE rising open cue on session open", cue2("open") === 1);
// pre-close idle: 30s of nothing — no rollover, no upload, still listening on the first
// window (step 5: the 45s silence close now owns pure idle — proven in scenario 21)
advance(30000); await RIG.settle();
check("30s idle: still listening on the FIRST window, nothing uploaded", RIG.fetches.length === 0 && RIG.starts === 1 && Voice2.isSessionOpen());
check("CUES: no cue from idling (state never left listening)", cue2("open") === 1);
// a transcribe FAILURE: window binned, session listens on
RIG.transcripts.push({ fail: "network down" });
await RIG.pump(Array(8).fill(40));                             // the driver speaks —
check("mid-window: state recording + the ✕ send-swap on the CLOUD engine", Voice2.state() === "recording" && el("sendBtn").textContent === "✕");
check("CUES: a listening→recording flip WITHIN a window never doubles the cue", cue2("open") === 1);
await RIG.pump(Array(32).fill(0)); await RIG.settle();         // — then quiet: cut → upload fails
check("failed upload: cs.fail logged, session still open, fresh window (no delivery)", kinds2().some(k => k.startsWith("cs.fail")) && Voice2.isSessionOpen() && RIG.starts === 2 && delivered2 === 0);
check("CUES: reopening AFTER the thinking spell earns exactly one new open cue", cue2("open") === 2);
// the driver's turn: speech → VAD quiet cut → upload → deliver — exactly once
RIG.transcripts.push("fuel prices in Tully");
await RIG.pump([...Array(8).fill(40), ...Array(32).fill(0)]); await RIG.settle();
check("speech flipped the state to recording (cs.vad:speech logged once this window)", kinds2().includes("cs.vad:speech"));
check("VAD quiet ended the window: ONE upload, deliver:cloud:silence in the ring buffer", RIG.fetches.length === 2 && kinds2().includes("deliver:cloud:silence"));
advance(700);
check("delivered exactly ONCE to the app; NO restart until the reply-flow resume (speak owns it now)", delivered2 === 1 && RIG.starts === 2);
check("CUES: still no extra open cue after the delivered turn (no reopen yet)", cue2("open") === 2);
// close: stream released, state off, session shut, ONE falling cue
Voice2.closeSession("tap");
check("close: cs.close logged, the held stream's tracks stopped, state off, session closed", kinds2().includes("cs.close:tap") && trackStops >= 1 && Voice2.state() === "off" && Voice2.isSessionOpen() === false);
check("CUES: close cue EXACTLY once for the tap close", cue2("close") === 1);
Voice2.closeSession("tap");                                    // a second close is a no-op
check("CUES: a repeat close never re-fires the cue (once per session)", cue2("close") === 1);
// a SECOND session: the guards re-arm — one fresh open cue, one close cue for a DIFFERENT reason
Voice2.openSession(); await RIG.settle();
check("CUES: a fresh session earns a fresh open cue (guard re-armed)", cue2("open") === 3 && Voice2.isSessionOpen());
Voice2.closeSession("phrase");
check("CUES: close cue once for the phrase close too (cs.close:phrase logged)", cue2("close") === 2 && kinds2().includes("cs.close:phrase"));
mockNavigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });   // restore
RIG.disable(); rafQueue.length = 0; timers.length = 0;

// ── SCENARIO 21: CS-SPEAKING — TTS clash, tail reopen, multi-turn, offer, 45s close,
// voiced-time artefact rule. All on the flag-ON instance; the shipped flag stays off.
console.log("\n--- 21. CS-speaking: TTS discipline, reply-flow resume, offer + 45s close, voiced-time artefact ---");
check("the shipped flag is ON (field build)", /const CS_ENABLED = true;/.test(SRC));
Voice2.clearLog(); rafQueue.length = 0; timers.length = 0; RIG.reset(); RIG.enable(); delivered2 = 0;
Voice2.openSession(); await RIG.settle();
// turn 1 delivers
RIG.transcripts.push("first question");
await RIG.pump([...Array(8).fill(40), ...Array(32).fill(0)]); await RIG.settle();
advance(700);
check("turn 1 delivered", delivered2 === 1 && RIG.fetches.length === 1);
const startsAfterT1 = RIG.starts;
// the app replies — the session must NOT hear (or upload) itself
Voice2.speak("Here is the answer.");
tts.start();
check("state speaking during the reply", Voice2.state() === "speaking");
await RIG.pump(Array(10).fill(40));       // the app's own voice hits the mic
check("NO capture while TTS plays: no new window, nothing of our own speech can upload", RIG.starts === startsAfterT1 && RIG.fetches.length === 1);
const openCuesBeforeResume = cue2("open");
tts.end(); advance(700); await RIG.settle();   // the 600ms tail → fresh window
check("after the tail: a fresh window, state listening", RIG.starts === startsAfterT1 + 1 && Voice2.state() === "listening");
check("CUES: exactly ONE reopen cue after the tail", cue2("open") === openCuesBeforeResume + 1);
// turn 2 + reply 2 — a genuine multi-turn session
RIG.transcripts.push("second question");
await RIG.pump([...Array(8).fill(40), ...Array(32).fill(0)]); await RIG.settle();
advance(700);
check("turn 2 delivered — the one-turn skeleton limit is LIFTED (two turns, one session)", delivered2 === 2 && RIG.fetches.length === 2 && Voice2.isSessionOpen());
Voice2.speak("Second answer."); tts.start(); tts.end(); advance(700); await RIG.settle();
check("after reply 2 the session listens again", Voice2.state() === "listening" && Voice2.isSessionOpen());
// the 20s offer — then the driver's answer is a NORMAL turn
advance(20100); await RIG.settle();
check("the offer fired at 20s idle (offer:anything-else) and binned the open window (cs.discard:offer)", kinds2().includes("offer:anything-else") && kinds2().includes("cs.discard:offer"));
tts.end(); advance(700); await RIG.settle();   // 'Anything else?' done → tail → answer window
RIG.transcripts.push("yes cheapest diesel");
await RIG.pump([...Array(8).fill(40), ...Array(32).fill(0)]); await RIG.settle();
advance(700);
check("the driver's answer to the offer was captured as a normal turn", delivered2 === 3 && RIG.fetches.length === 3);
// genuine driver silence: the offer fires once more for this quiet spell, then the 45s close
const closeCuesBefore = cue2("close");
advance(21000); await RIG.settle();            // the offer nudges again …
tts.end(); advance(700); await RIG.settle();   // … finishes + tail
advance(30000); await RIG.settle();            // … and the 45s (from the last speech) runs out
check("45s of driver silence closed the session with its reason (cs.close:silence)", kinds2().includes("cs.close:silence") && Voice2.isSessionOpen() === false && Voice2.state() === "off");
check("CUES: exactly one close cue for the silence close", cue2("close") === closeCuesBefore + 1);
// voiced-time artefact rule — both ways (a fresh session)
Voice2.clearLog(); RIG.reset(); delivered2 = 0; rafQueue.length = 0; timers.length = 0;
Voice2.openSession(); await RIG.settle();
RIG.transcripts.push("Thank you.");
await RIG.pump([...Array(3).fill(40), ...Array(32).fill(0)]); await RIG.settle();   // ~0.2s of actual speech in a ~3.5s window
advance(700);
check("artefact phrase + SHORT voiced time (~0.2s) → binned on VOICED time (blob duration would have passed it)", kinds2().includes("cs.discard:artefact") && delivered2 === 0);
check("…and the session rolled to a fresh window", Voice2.isSessionOpen() && RIG.starts === 2);
RIG.transcripts.push("thank you very much");
await RIG.pump([...Array(20).fill(40), ...Array(32).fill(0)]); await RIG.settle();  // ~1.9s of real speech
advance(700);
check("the same stock phrase with REAL voiced time (~1.9s) DELIVERS", delivered2 === 1);
Voice2.closeSession("tap");
RIG.disable(); rafQueue.length = 0; timers.length = 0;

// ── SCENARIO 22: CS-CANCEL — ✕ + spoken "scratch that" on the cloud engine ─────
console.log("\n--- 22. CS-cancel: ✕ discards + fresh window; spoken cancel routes nowhere; harmless no-ops; close clock untouched ---");
check("the shipped flag is ON (field build)", /const CS_ENABLED = true;/.test(SRC));
// (a) ✕ mid-recording: discard, blip, fresh window, session open — and the 45s close is NOT reset
Voice2.clearLog(); rafQueue.length = 0; timers.length = 0; RIG.reset(); RIG.enable(); delivered2 = 0;
Voice2.openSession(); await RIG.settle();            // close armed at open (t0)
await RIG.pump(Array(8).fill(40));                    // driver speaking — last voiced tick re-arms the close
check("mid-recording: state recording, ✕ showing", Voice2.state() === "recording" && el("sendBtn").textContent === "✕");
const cancelsBefore = kinds2().filter(k => k === "cancel:tap-session").length;
advance(2000);                                        // a beat later (under the 2.8s cut) the driver hits ✕
Voice2.cancelCapture();
check("✕ on cs: cancel:tap-session + cs.discard:cancel logged, ZERO uploads", kinds2().filter(k => k === "cancel:tap-session").length === cancelsBefore + 1 && kinds2().includes("cs.discard:cancel") && RIG.fetches.length === 0);
check("✕ on cs: a FRESH window opened, session still open, state listening", RIG.starts === 2 && Voice2.isSessionOpen() && Voice2.state() === "listening");
check("CUES: the fresh post-cancel turn earned a new open cue", cue2("open") === 2);
check("one-shot state untouched by a cs cancel (isolation holds in source)", /if \(csActive\) \{\n    if \(csSpeaking \|\| !csRec\) return;\n    logEvent\('cancel', 'tap-session'\);\n    cancelBlip\(\);\n    csDiscardWindow\('cancel'\);/.test(SRC));
// the 45s close was armed by the SPEECH (t_speech+45000), not the cancel: at t_speech+45.5s it must be CLOSED
advance(43500); await RIG.settle();                   // t_cancel+43.5s ≈ t_speech+45.5s < t_cancel+45s
check("the 45s close fired on the SPEECH clock — the cancel did NOT reset it", kinds2().includes("cs.close:silence") && Voice2.isSessionOpen() === false);
// (b) spoken "scratch that": binned before _onTranscript, blip, fresh window, session open
Voice2.clearLog(); rafQueue.length = 0; timers.length = 0; RIG.reset(); delivered2 = 0;
Voice2.openSession(); await RIG.settle();
RIG.transcripts.push("find fuel scratch that");
await RIG.pump([...Array(8).fill(40), ...Array(32).fill(0)]); await RIG.settle();
advance(700);
check("spoken cancel: cancel:spoken logged and the utterance NEVER reached _onTranscript", kinds2().includes("cancel:spoken") && delivered2 === 0);
check("spoken cancel: fresh window, session open, state listening", RIG.starts === 2 && Voice2.isSessionOpen() && Voice2.state() === "listening");
check("spoken cancel on cs blips + reopens (source: cancelBlip in the cs spoken branch)", /if \(csActive\) \{ cancelBlip\(\); openCued = false; if \(!csSpeaking\) csStartWindow\(\); \}/.test(SRC));
// (c) harmless no-ops: nothing recording (post-deliver / during the TTS tail) → no blip spam, no double windows
RIG.transcripts.push("real question");
await RIG.pump([...Array(8).fill(40), ...Array(32).fill(0)]); await RIG.settle();
advance(700);
check("setup: a real turn delivered", delivered2 === 1);
const logLenAfterDeliver = Voice2.getLog().length;
Voice2.cancelCapture();                               // post-deliver: NO window running → no-op
check("cancel with nothing recording is a silent no-op (no log entries, no discard)", Voice2.getLog().length === logLenAfterDeliver);
Voice2.speak("The answer."); tts.start(); tts.end();  // reply done — the 600ms tail is pending
const startsBeforeTailCancel = RIG.starts;
Voice2.cancelCapture();                               // during the tail: csSpeaking → no-op
advance(700); await RIG.settle();
check("cancel during the post-TTS tail: no-op, then exactly ONE window opens (no doubles)", RIG.starts === startsBeforeTailCancel + 1 && Voice2.isSessionOpen() && Voice2.state() === "listening");
Voice2.closeSession("tap");
RIG.disable(); rafQueue.length = 0; timers.length = 0;

// ── SCENARIO 23: CS-SEAM — engine pick, micTap close, honest swaps, no ping-pong ─
console.log("\n--- 23. CS-seam: engine pick both ways, micTap, denied-swap, fail-streak swap, no ping-pong ---");
check("the shipped flag is ON (field build)", /const CS_ENABLED = true;/.test(SRC));
check("no ping-pong is POSSIBLE: csOpen has exactly ONE call site (the engine pick)", (SRC.match(/\{ csOpen\(\); return; \}/g) || []).length === 1 && (SRC.match(/csOpen\(\)/g) || []).length === 2);
// (a) engine pick both ways + (b) micTap
Voice2.clearLog(); rafQueue.length = 0; timers.length = 0; RIG.reset(); RIG.enable(); delivered2 = 0;
Voice2.openSession(); await RIG.settle();
check("pick: Android + full cloud kit → the CLOUD session", kinds2().includes("cs.open:session") && Voice2.isSessionOpen());
Voice2.micTap();
check("micTap closes the cs session: cs.close:tap, ONE close cue, off", kinds2().includes("cs.close:tap") && cue2("close") === 1 && Voice2.state() === "off" && !Voice2.isSessionOpen());
Voice2.clearLog(); RIG.reset(); RIG.disable();
Voice2.openSession(); await RIG.settle();
check("pick: Android WITHOUT MediaRecorder → the Web-Speech session, untouched", kinds2().includes("open:session") && !kinds2().some(k => k.startsWith("cs.")));
Voice2.closeSession("tap");
RIG.enable();
const Voice3 = loader2(mockWindow, mockDocument, mockNavigator, MockUtt, fakeSetTimeout, fakeClearTimeout, fakeRAF, FakeDate, silentConsole);
Voice3.onTranscript(() => {}); Voice3.setBusyGetter(() => false);
const kinds3 = () => Voice3.getLog().map(e => e.kind + (e.detail ? ":" + e.detail : ""));
Voice3.openSession(); await RIG.settle();
check("pick: NON-Android with MediaRecorder present → still Web Speech (the Android gate)", kinds3().includes("open:session") && !kinds3().some(k => k.startsWith("cs.")));
Voice3.closeSession("tap");
Voice2.clearLog(); RIG.reset();
Voice2.micTap(); await RIG.settle();
check("micTap idle → OPENS the cloud session (arbitration stays exhaustive)", kinds2().includes("cs.open:session") && Voice2.isSessionOpen());
Voice2.closeSession("tap");
// (c) denied mic at open → honest line, the Web-Speech session carries the SAME exchange
const seamMsgs = [];                                     // the bench addMsg is a no-op — record locally
const _addMsg0 = globalThis.addMsg; globalThis.addMsg = (r, t) => { seamMsgs.push(t); };
Voice2.clearLog(); rafQueue.length = 0; timers.length = 0; RIG.reset(); delivered2 = 0;
mockNavigator.mediaDevices.getUserMedia = async () => { throw new Error("NotAllowedError"); };
Voice2.openSession(); await RIG.settle();
check("denied: cs.open:denied + cs.swap:denied, the honest line shown", kinds2().includes("cs.open:denied") && kinds2().includes("cs.swap:denied") && seamMsgs.some(m => /Cloud listening isn't working right now/.test(m)));
check("denied: the Web-Speech session OPENED (recogniser live)", kinds2().includes("open:session") && Voice2.isSessionOpen() && H.rec !== null);
tts.start(); tts.end(); advance(700);            // the honest line plays; tail; mic resumes
rec.onstart(); rec.speech(); rec.final("how far to Tully"); advance(2800); advance(700);
check("denied: the exchange CARRIES ON — a turn delivered on the fallback", delivered2 === 1);
Voice2.closeSession("tap");
mockNavigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() {} }] });
// (d) the fail streak: 2 fails + a success reset it (no swap)…
Voice2.clearLog(); rafQueue.length = 0; timers.length = 0; RIG.reset(); RIG.enable(); delivered2 = 0;
Voice2.openSession(); await RIG.settle();
RIG.transcripts.push({ fail: "down" }, { fail: "down" }, "still with you");
for (let i = 0; i < 3; i++) { await RIG.pump([...Array(8).fill(40), ...Array(32).fill(0)]); await RIG.settle(); }
advance(700);
check("2 fails then a success: NO swap — the streak resets on a good round trip", !kinds2().some(k => k.startsWith("cs.swap")) && delivered2 === 1 && Voice2.isSessionOpen());
Voice2.closeSession("tap");
// …and 3 CONSECUTIVE fails swap exactly once, cue-less, exchange continuing on Web Speech
Voice2.clearLog(); rafQueue.length = 0; timers.length = 0; RIG.reset(); delivered2 = 0;
Voice2.openSession(); await RIG.settle();
RIG.transcripts.push({ fail: "down" }, { fail: "down" }, { fail: "down" });
for (let i = 0; i < 3; i++) { await RIG.pump([...Array(8).fill(40), ...Array(32).fill(0)]); await RIG.settle(); }
check("3 consecutive fails: EXACTLY one honest swap (cs.swap:transcribe + cs.close:swap)", kinds2().includes("cs.swap:transcribe") && kinds2().includes("cs.close:swap") && kinds2().filter(k => k.startsWith("cs.swap")).length === 1);
check("the swap is CUE-LESS — the exchange continues, no false ending", cue2("close") === 0);
check("the honest swap line + the Web-Speech session live", seamMsgs.some(m => /switching to the phone's own listening/.test(m)) && kinds2().includes("open:session") && Voice2.isSessionOpen());
tts.start(); tts.end(); advance(700);
rec.onstart(); rec.speech(); rec.final("any camps ahead"); advance(2800); advance(700);
check("the exchange CONTINUES on the fallback (a turn delivered after the swap)", delivered2 === 1);
Voice2.closeSession("tap");
check("the post-swap close cues ONCE via the convo path (guard re-armed at the swap open)", cue2("close") === 1);
globalThis.addMsg = _addMsg0;                             // restore the no-op mock
RIG.disable(); rafQueue.length = 0; timers.length = 0;

// ── SCENARIO 24: CS-LOG — the full lifecycle vocabulary, in order; swap; privacy ─
console.log("\n--- 24. CS-log: lifecycle event sequence in ORDER; swap sequence; privacy ---");
check("the shipped flag is ON (field build)", /const CS_ENABLED = true;/.test(SRC));
const inOrder = (log, seq) => { let i = 0; for (const k of log) { if (i < seq.length && (typeof seq[i] === "string" ? k === seq[i] : seq[i].test(k))) i++; } return i === seq.length; };
const SCRIPTS = ["caravan parks near port douglas", "cheapest diesel in tully"];
Voice2.clearLog(); rafQueue.length = 0; timers.length = 0; RIG.reset(); RIG.enable(); delivered2 = 0;
Voice2.openSession(); await RIG.settle();
RIG.transcripts.push(SCRIPTS[0]);                               // turn 1 → deliver
await RIG.pump([...Array(8).fill(40), ...Array(32).fill(0)]); await RIG.settle(); advance(700);
Voice2.speak("Three parks near Port Douglas."); tts.start(); tts.end(); advance(700); await RIG.settle();   // reply 1 → reopen
await RIG.pump(Array(5).fill(40));                              // cancel mid-window
Voice2.cancelCapture();
RIG.transcripts.push({ fail: "down" });                         // a failed upload
await RIG.pump([...Array(8).fill(40), ...Array(32).fill(0)]); await RIG.settle();
RIG.audio = new Blob(["x".repeat(500)], { type: "audio/webm" });   // a sub-minimum window → the LOCAL-discard path
await RIG.pump([...Array(8).fill(40), ...Array(32).fill(0)]); await RIG.settle();
RIG.audio = new Blob(["x".repeat(4096)], { type: "audio/webm" });
advance(20100); await RIG.settle();                             // the offer fires for this quiet spell
tts.end(); advance(700); await RIG.settle();                    // offer spoken → answer window
RIG.transcripts.push(SCRIPTS[1]);                               // the driver's answer
await RIG.pump([...Array(8).fill(40), ...Array(32).fill(0)]); await RIG.settle(); advance(700);
Voice2.micTap();                                                // close
const L24 = kinds2();
check("lifecycle IN ORDER: pick→open→window→cue→speech→upload→deliver→tts→reopen→cancel→fail→local-discard→offer→answer→close", inOrder(L24, [
  "engine:cloud", "cs.open:session", /^cs\.window:\d+$/, "cue:open",
  "cs.vad:speech", /^cs\.upload:/, "deliver:cloud:silence",
  "tts.start", "tts.end", /^cs\.window:/, "cue:open",
  "cancel:tap-session", "cs.discard:cancel", /^cs\.window:/,
  /^cs\.fail:/, /^cs\.window:/,
  /^cs\.discard:silence:\d+ms$/, /^cs\.window:/,
  "offer:anything-else", "cs.discard:offer", /^cs\.window:/,
  /^cs\.upload:/, "deliver:cloud:silence",
  "cue:close", "cs.close:tap",
]), L24.join(" | "));
check("the upload event carries size + VOICED time", L24.some(k => /^cs\.upload:\d+b \d+ms$/.test(k)));
check("every window outcome is readable from the log alone", L24.includes("cs.discard:cancel") && L24.includes("cs.discard:offer") && L24.some(k => /^cs\.fail:/.test(k)) && L24.some(k => /^cs\.discard:silence:/.test(k)));
const flat24 = Voice2.getLog().map(e => e.kind + " " + e.detail).join("\n").toLowerCase();
check("PRIVACY: no logged string contains any scripted transcript text", SCRIPTS.every(t => !flat24.includes(t)) && !flat24.includes("port douglas") && !flat24.includes("diesel"));
// the swap session's sequence
Voice2.clearLog(); rafQueue.length = 0; timers.length = 0; RIG.reset(); delivered2 = 0;
Voice2.openSession(); await RIG.settle();
RIG.transcripts.push({ fail: "down" }, { fail: "down" }, { fail: "down" });
for (let i = 0; i < 3; i++) { await RIG.pump([...Array(8).fill(40), ...Array(32).fill(0)]); await RIG.settle(); }
check("swap sequence IN ORDER: pick → open → fail x1..x3 → swap → cs.close:swap → Web-Speech open", inOrder(kinds2(), [
  "engine:cloud", "cs.open:session", /^cs\.fail:.* x1$/, /^cs\.fail:.* x2$/, /^cs\.fail:.* x3$/, "cs.swap:transcribe", "cs.close:swap", "open:session",
]), kinds2().join(" | "));
Voice2.closeSession("tap");
RIG.disable(); rafQueue.length = 0; timers.length = 0;

console.log("\n" + (ok ? "ALL PASS" : "FAILURES ABOVE"));
process.exit(ok ? 0 : 1);
