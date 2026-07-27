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
const mockDocument = { getElementById: () => stubEl(), querySelectorAll: () => [], createElement: () => stubEl() };
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

console.log("\n" + (ok ? "ALL PASS" : "FAILURES ABOVE"));
process.exit(ok ? 0 : 1);
