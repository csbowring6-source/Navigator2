// speech.js — Navigator VOICE SUBSYSTEM. Extracted whole from index.html.
// Loaded as a CLASSIC script BEFORE the inline app script:
//     <script src="speech.js?v=STAMP"></script>
// Exposes ONE global — window.Voice. Nothing outside this file may touch voice
// internals. The module still calls a few app-level GLOBALS by name (addMsg,
// setPending, pendingQuestion, pendingIsFresh, cleanTranscript, autoResize,
// API_URL, lastSpoken) — those live in index.html and resolve at call time via
// the shared global scope of classic scripts. The two app COUPLINGS are INJECTED
// (never read from app state): Voice.onTranscript(cb) is the transcript handoff
// (was a direct sendMessage() call) and Voice.setBusyGetter(fn) reads the app's
// busy flag. Version pinning: the ?v= query on the script tag AND Voice.BUILD
// below both carry the #buildStamp; index.html shows the update banner on any
// mismatch, so a stale module cannot go unnoticed.
// NO behaviour change in this extraction — code was MOVED, not fixed.
window.Voice = (function () {

  // ── app couplings (injected by index.html; the module never reads app state)
  let _onTranscript = function () {};              // was: sendMessage()
  let _isBusy = function () { return false; };     // was: reading the global `busy`

  // ── EVENT RING BUFFER (last 200) — on-phone diagnosis with no laptop ───────
  // Every state transition, recogniser event, TTS start/stop, cue and open/close
  // is stamped here. Voice.getLog() reads it; the voice-log view renders + copies
  // it; the Phase-3 bench replays it. Kept small and allocation-cheap.
  // DURABLE: mirrored into localStorage so a reload — update-banner tap, refresh,
  // or a backgrounded mobile tab getting reclaimed — doesn't wipe the run. We use
  // localStorage, NOT sessionStorage: an evicted background tab (or an app relaunch)
  // keeps localStorage but can drop sessionStorage, which is exactly the wipe we're
  // fixing. typeof-guarded + try/catch so the module still loads where storage is
  // absent (the bench rig) or throws (Safari private mode). The 200 cap is enforced
  // over the whole persisted buffer, and each reload appends a "--- reload ---"
  // divider so separate runs stay distinguishable in the log view.
  const VLOG_MAX = 200;
  const VLOG_KEY = 'navigator_vlog';
  let vlog = [];
  function persistVlog() {
    try { if (typeof localStorage !== 'undefined' && localStorage) localStorage.setItem(VLOG_KEY, JSON.stringify(vlog)); } catch (e) {}
  }
  (function restoreVlog() {
    try {
      if (typeof localStorage === 'undefined' || !localStorage) return;
      const arr = JSON.parse(localStorage.getItem(VLOG_KEY) || 'null');
      if (Array.isArray(arr) && arr.length) {
        vlog = arr.filter(e => e && typeof e.t === 'number' && typeof e.kind === 'string');
        vlog.push({ t: Date.now(), kind: '--- reload ---', detail: '' });     // boundary between runs
        if (vlog.length > VLOG_MAX) vlog.splice(0, vlog.length - VLOG_MAX);    // cap across the whole buffer
        persistVlog();
      }
    } catch (e) { vlog = []; }
  })();
  function logEvent(kind, detail) {
    vlog.push({ t: Date.now(), kind: kind, detail: (detail == null ? '' : detail) });
    if (vlog.length > VLOG_MAX) vlog.shift();
    persistVlog();
  }

  // ── moved voice state (was index.html:1889-1892) ───────────────────────────
  let recognition = null;
  let isListening = false;
  const synth = window.speechSynthesis;

// ── CONVERSATION MODE — mic reopens after each spoken reply ──────────────────
// ── CONVERSATION SESSION (rebuilt as a session model) ────────────────────────
// One tap OPENS a session that stays open across turns with no further taps.
// The tap is a real user gesture — it unlocks an AudioContext and creates ONE
// SpeechRecognition, both kept alive for the whole session (iOS mitigation).
// The recogniser is restarted (never recreated) within the session; the mic
// permission stream is kept warm. Closes on: tap again · a closing phrase · 45s
// silence · an "anything else?" offer that goes unanswered. If WebKit can't
// sustain continuous listening despite the mitigations, the session fails
// honestly (closes, red state, "tap per question") — it never silently degrades.
let convoActive = false;        // session open?
let convoRec = null;            // the ONE SpeechRecognition — alive for the session
let convoRecRunning = false;    // is it currently started
let convoSpeaking = false;      // app is speaking a reply — listening paused
let convoStream = null;         // kept-warm permission stream
let convoAudioCtx = null;       // unlocked on the opening tap, kept alive
let convoSilenceTimer = null;   // 45s hard close
let convoOfferTimer = null;     // "anything else?" nudge before the close
let convoOffered = false;       // nudge already made this quiet spell
let convoHadExchange = false;   // app has replied at least once
// End-of-TURN accumulation (distinct from the session close timers above). Android
// finalises mid-phrase, so a turn arrives as several final chunks across events and
// even across recogniser restarts. We accumulate the growing final text and deliver
// ONCE, when the driver pauses (CONVO_TURN_MS) — never on the first chunk.
let convoTurn = '';             // full final text this session-run (grows monotonically)
let convoDelivered = '';        // the prefix of convoTurn already handed off
let convoDeliverTimer = null;   // fires the turn after a real pause
const CONVO_TURN_MS = 2800;     // end-of-turn silence — matches the cloud/basic paths
// TTS suppression + oscillation guard. The recogniser must NOT hear the app's own
// reply: we keep it shut through playback AND a short tail (the speaker is still
// emitting and the room echoes). If the mic still flips recording<->listening
// without making progress, an echo loop is running — cap it and close honestly.
let convoResumeTimer = null;    // deferred mic reopen after playback ends
let convoFlips = 0;             // recording<->listening flips since real progress
let convoLastState = '';        // last convo-driven mic state (for flip detection)
const CONVO_TTS_TAIL_MS = 600;  // keep the mic shut this long AFTER playback ends
const CONVO_MAX_FLIPS = 8;      // oscillation ceiling — close honestly beyond this
// Reopen ceiling. The flip ceiling above only catches recording<->listening
// churn; a post-TTS restart loop can instead reopen the recogniser over and over
// (Android's early onend) with NO turn ever delivered, emitting the device's own
// mic earcon ~once a second. Count reopens that had NO delivered turn between
// them; past this many, we're in a stuck loop → close honestly. The count is
// cleared on a delivered turn AND on any recogniser that stayed alive past
// CONVO_HEALTHY_MS (a genuine listen, just quiet) — so a legitimately quiet
// session keeps its full 45s grace, while a rapid sub-healthy loop (each cycle
// under CONVO_HEALTHY_MS) climbs to the cap in ~N cycles regardless of exact
// spacing and closes. Ambient noise no longer resets it (that was the leak).
const CONVO_MAX_CYCLES = 5;     // empty (no-delivery) reopens before an honest close
let convoUndelivered = 0;       // consecutive sub-healthy reopens with nothing delivered
let convoLastStart = 0;         // when convoRec last started (for the alive-check + logging)
let convoRestarts = 0;          // consecutive reopens with NO capture — bounded, never infinite
let convoCued = false;          // close cue already played this session? (at most once)
let convoLastError = '';        // last onerror reason, for the honest-fail log
const CONVO_MAX_RESTARTS = 3;   // after this many rapid empty reopens, stop + honest fallback
const CONVO_HEALTHY_MS = 2000;  // an onend later than this = genuine listening (just quiet), not a fail
const CONVO_ANDROID = /Android/i.test(navigator.userAgent || '');
const CONVO_OFFER_MS = 20000;
const CONVO_CLOSE_MS = 45000;

function convoSupported() { return ('webkitSpeechRecognition' in window) || ('SpeechRecognition' in window); }

function toggleConversation() {
  if (convoActive) closeConversation('tap');
  else openConversation();
}

// The opening TAP (a real gesture): unlock audio + start the ONE recogniser here,
// synchronously, before any await — this is what makes it hold on iOS.
function openConversation() {
  if (!convoSupported()) {
    const m = "This browser can't do hands-free listening — tap the mic for each question.";
    addMsg('nav', m); lastSpoken = m; speak(m); return;
  }
  try { const Ctx = window.AudioContext || window.webkitAudioContext; if (Ctx && !convoAudioCtx) convoAudioCtx = new Ctx(); convoAudioCtx && convoAudioCtx.resume && convoAudioCtx.resume(); } catch(e) {}
  unlockAudio();
  try { if (captureActive) stopCapture(false); } catch(e) {}   // don't let two mics fight
  logEvent('open', 'session');
  convoActive = true; convoOffered = false; convoHadExchange = false;
  convoRestarts = 0; convoCued = false; convoLastError = '';
  convoTurn = ''; convoDelivered = ''; clearTimeout(convoDeliverTimer);   // fresh turn accumulator
  convoFlips = 0; convoLastState = ''; convoUndelivered = 0; clearTimeout(convoResumeTimer);    // fresh oscillation guards
  convoSetState('listening');       // session open, waiting for speech
  convoStartRecogniser();          // creates + starts convoRec IN the gesture
  convoArmSilence();
  // Warm the mic ONLY where it demonstrably helps. On Android Chrome a held
  // getUserMedia stream blocks SpeechRecognition from acquiring the mic (the
  // restart-loop bug), so we never keep one there — the recogniser owns the mic.
  // iOS WebKit keeps the best-effort warm hold.
  if (!CONVO_ANDROID && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(s => { if (convoActive) convoStream = s; else s.getTracks().forEach(t => t.stop()); })
      .catch(() => {});
  }
}

// Every convo-driven mic state goes through here so an echo loop can't run
// forever. A flip between the two LIVE states (recording<->listening) with no
// progress (no new transcript, no delivered turn) counts toward a ceiling; past
// it, the session closes honestly with the reason on screen. Real speech and a
// delivered turn reset the count, so normal multi-turn use never trips it.
function convoSetState(state) {
  if ((state === 'recording' || state === 'listening') &&
      (convoLastState === 'recording' || convoLastState === 'listening') &&
      state !== convoLastState) {
    convoFlips++;
    if (convoFlips > CONVO_MAX_FLIPS) {
      console.warn('[convo] oscillation ceiling hit (' + convoFlips + ' flips, no progress) — closing honestly');
      convoLastError = 'oscillation'; convoFailHonestly();
      return;
    }
  }
  convoLastState = state;
  setMicState(state);
}

// Record one recogniser (re)open and enforce the ceiling. A healthy session
// reopens once per reply — the counter is cleared on every DELIVERED turn (and at
// session open, and whenever a recogniser proved healthy) — so those never
// accumulate. Only rapid sub-healthy reopens with nothing delivered pile up; past
// CONVO_MAX_CYCLES we're in a stuck restart loop (the source of the once-a-second
// native earcon) → close honestly, reason on screen. Returns true if it closed.
function convoNoteReopen() {
  convoUndelivered++;
  logEvent('reopen', convoUndelivered);
  if (convoUndelivered >= CONVO_MAX_CYCLES) {
    console.warn('[convo] ' + convoUndelivered + ' reopens with no delivered turn — closing honestly (stuck restart loop)');
    convoLastError = 'oscillation'; convoFailHonestly(); return true;
  }
  return false;
}

function convoStartRecogniser() {
  if (!convoActive) return;
  if (convoNoteReopen()) return;   // stuck reopen loop → honest close, don't restart
  if (!convoRec) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    convoRec = new SR();                 // the ONE instance — never recreated per turn
    convoRec.lang = 'en-AU';
    convoRec.continuous = true;
    convoRec.interimResults = true;
    convoRec.onstart = () => { convoRecRunning = true; logEvent('rec.onstart', 'convo'); if (convoActive && !convoSpeaking) convoSetState('listening'); console.log('[convo] recogniser started'); };
    convoRec.onspeechstart = () => { if (convoSpeaking) return; logEvent('rec.speechstart', 'convo'); convoArmSilence(); if (convoActive) convoSetState('recording'); };
    convoRec.onresult = e => {
      if (convoSpeaking) return;             // ignore anything heard during playback/tail (our own voice)
      logEvent('rec.onresult', 'convo');
      convoRestarts = 0; convoArmSilence();   // any speech resets the SESSION close timers
      let fin = '', interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const seg = (e.results[i][0] && e.results[i][0].transcript) || '';
        if (e.results[i].isFinal) fin = mergeFinal(fin, seg); else interim = mergeFinal(interim, seg);
      }
      // Grow the turn's final text overlap-aware (mergeFinal drops Android's
      // re-heard chunks, so this survives mid-phrase restarts without dupes).
      if (fin) convoTurn = mergeFinal(convoTurn, fin);
      // NOTE: growth alone does NOT reset the oscillation guards — ambient noise
      // the engine finalises grows convoTurn too, and resetting on it let the echo
      // loop run forever. convoFlips / convoUndelivered reset ONLY on a delivered
      // turn (convoDeliverTurn), which is real progress.
      if (convoTurn.length > convoDelivered.length || interim.trim()) {
        if (convoActive) convoSetState('recording');
        armConvoDeliver();                    // deliver only after the driver pauses
      }
    };
    convoRec.onerror = e => {
      convoLastError = (e && e.error) || 'unknown';
      logEvent('rec.onerror', convoLastError);
      console.warn('[convo] recogniser onerror:', convoLastError);
      // A hard permission denial is terminal — fail honestly now. Everything else
      // (no-speech / aborted / audio-capture / network) falls through to onend,
      // which restarts under the bounded cap below.
      if (convoLastError === 'not-allowed' || convoLastError === 'service-not-allowed') convoFailHonestly();
    };
    convoRec.onend = () => {
      convoRecRunning = false;
      logEvent('rec.onend', 'convo');
      if (!convoActive || convoSpeaking) return;   // a deliberate pause (speaking) or a close
      // Bounded restart. A recogniser that stayed open past CONVO_HEALTHY_MS was
      // genuinely listening (the driver was just quiet) — reset the fail count and
      // let the 45s silence timer own the close. A rapid empty reopen (mic never
      // acquired) does NOT reset, so it climbs to the cap and then stops honestly.
      const alive = Date.now() - convoLastStart;
      if (alive >= CONVO_HEALTHY_MS) { convoRestarts = 0; convoUndelivered = 0; }   // a genuine listen (just quiet) — not a loop
      convoRestarts++;
      if (convoRestarts > CONVO_MAX_RESTARTS) {
        console.warn('[convo] giving up after ' + (convoRestarts - 1) + ' rapid restarts with no capture (last alive=' + alive + 'ms, last onerror: ' + (convoLastError || 'none') + ')');
        convoFailHonestly(); return;
      }
      const backoff = 250 * convoRestarts;   // 250 / 500 / 750 ms
      console.warn('[convo] restart ' + convoRestarts + '/' + CONVO_MAX_RESTARTS + ' in ' + backoff + 'ms (alive=' + alive + 'ms, last onerror: ' + (convoLastError || 'none') + ')');
      setTimeout(() => {
        if (!convoActive || convoSpeaking) return;
        if (convoNoteReopen()) return;   // wall-clock ceiling: stuck reopen loop → honest close
        try { convoRec.start(); convoLastStart = Date.now(); } catch(_) {}
      }, backoff);
    };
  }
  try { convoRec.start(); convoRecRunning = true; convoLastStart = Date.now(); } catch (e) { /* already running */ }
}
function convoStopRecogniser() {
  if (convoRec && convoRecRunning) { try { convoRec.stop(); } catch(e) {} }
  convoRecRunning = false;
}

// Re-arm the end-of-turn timer on every scrap of speech; it fires once the driver
// has actually paused, delivering the WHOLE turn (not the first chunk).
function armConvoDeliver() { clearTimeout(convoDeliverTimer); convoDeliverTimer = setTimeout(convoDeliverTurn, CONVO_TURN_MS); }
function convoDeliverTurn() {
  if (!convoActive || convoSpeaking || _isBusy()) return;   // paused, closing, or still processing the last turn
  const pending = convoTurn.length > convoDelivered.length ? convoTurn.slice(convoDelivered.length).trim() : '';
  if (!pending) return;
  convoDelivered = convoTurn;                          // consume — never re-delivered
  convoFlips = 0; convoUndelivered = 0;                // a delivered turn is real progress — clear BOTH oscillation guards
  convoHandleUtterance(pending, 'silence');            // a session turn always ends on a pause
}
function convoHandleUtterance(text, endReason) {
  if (isConvoClosePhrase(text)) { closeConversation('phrase'); return; }
  deliverTranscript(text, 'basic', endReason || 'silence');   // normal pipeline; the reply's speak() pauses us
}
function isConvoClosePhrase(text) {
  const t = cleanTranscript(text).toLowerCase();
  return t.length <= 25 && /^(that'?s it|that'?s all|that is all|thanks|thank you|cheers|done|all done|i'?m done|no that'?s it|that will do|bye|goodbye|close|stop( listening)?)\b/.test(t);
}

// Silence handling: nudge at 20s, hard close at 45s. Reset on any speech/reply.
function convoArmSilence() {
  clearTimeout(convoSilenceTimer); clearTimeout(convoOfferTimer);
  convoOffered = false;
  if (convoHadExchange) convoOfferTimer = setTimeout(convoOffer, CONVO_OFFER_MS);
  convoSilenceTimer = setTimeout(() => closeConversation('silence'), CONVO_CLOSE_MS);
}
// The OFFER — "anything else?". Not a close: answering it keeps the session going;
// the 45s close timer keeps running underneath so silence still ends it.
function convoOffer() {
  if (!convoActive || convoOffered) return;
  convoOffered = true;
  logEvent('offer', 'anything-else');
  convoSpeaking = true; convoStopRecogniser(); setMicState('speaking');
  // Same echo discipline as speak(): stay shut through a tail, THEN reopen.
  const resume = () => { clearTimeout(convoResumeTimer); convoResumeTimer = setTimeout(() => { convoSpeaking = false; if (convoActive) { convoSetState('listening'); convoStartRecogniser(); } }, CONVO_TTS_TAIL_MS); };
  try {
    synth && synth.cancel();
    const u = new SpeechSynthesisUtterance('Anything else?');
    u.lang = 'en-AU'; u.rate = 0.95;
    u.onend = resume;    // resume; do NOT re-arm
    u.onerror = resume;
    synth ? synth.speak(u) : resume();
  } catch (e) { resume(); }
}

// A short beep so a driver not looking at the screen knows the session closed.
// Uses the gesture-created AudioContext, so it sounds even on a timer-driven close.
function convoCloseCue() {
  if (convoCued) return;   // at most ONE close cue per session — never per restart
  convoCued = true;
  logEvent('cue', 'close');
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = convoAudioCtx || (Ctx && new Ctx());
    if (!ctx) return; convoAudioCtx = ctx;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = 420;
    g.gain.setValueAtTime(0.16, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + 0.3);
  } catch (e) {}
}

function releaseConvoStream() { try { if (convoStream) convoStream.getTracks().forEach(t => t.stop()); } catch(e) {} convoStream = null; }

function closeConversation(reason) {
  const wasActive = convoActive;
  logEvent('close', reason + (wasActive ? '' : ' (noop)'));
  convoActive = false; convoSpeaking = false; convoRecRunning = false;
  clearTimeout(convoSilenceTimer); clearTimeout(convoOfferTimer); clearTimeout(convoDeliverTimer); clearTimeout(convoResumeTimer);
  convoTurn = ''; convoDelivered = ''; convoFlips = 0; convoLastState = ''; convoUndelivered = 0;   // drop any half-heard turn / oscillation state
  if (convoRec) { try { convoRec.onend = null; convoRec.onerror = null; convoRec.onresult = null; convoRec.abort ? convoRec.abort() : convoRec.stop(); } catch(e) {} }
  convoRec = null;                       // fresh instance next session; alive across THIS one
  releaseConvoStream();
  setMicState('off');
  if (wasActive) convoCloseCue();        // audible close cue
  if (reason === 'honest') {
    const m = "Hands-free listening won't hold on this browser — tap the mic for each question.";
    // On-screen diagnostic — the field phone has no reachable console. Small grey
    // text under the message: the last error reason, plus the restart count if it
    // hit the cap. e.g. "(audio-capture, 3 restarts)". Never spoken aloud.
    const parts = [];
    if (convoLastError) parts.push(convoLastError);
    if (convoRestarts > CONVO_MAX_RESTARTS) parts.push(CONVO_MAX_RESTARTS + ' restarts');
    const diag = parts.length ? '(' + parts.join(', ') + ')' : '';
    console.warn('[convo] honest fail ' + diag);
    addMsg('nav', m, m); lastSpoken = m; speak(m);   // 3rd arg = spoken variant (no code read aloud)
    if (diag) {
      const bubbles = document.querySelectorAll('#chatArea .msg.nav .msg-bubble');
      const bub = bubbles[bubbles.length - 1];
      if (bub) { const d = document.createElement('div'); d.textContent = diag; d.style.cssText = 'font-size:11px;opacity:0.6;margin-top:4px;'; bub.appendChild(d); }
    }
  } else if (reason === 'phrase' || reason === 'silence') {
    const m = 'Righto — tap the mic when you need me.';
    addMsg('nav', m); lastSpoken = m; speak(m);
  }
}
function convoFailHonestly() { closeConversation('honest'); }

// ── ONE MIC STATE MACHINE — the SOLE writer of every mic indicator ───────────
// Five states: off · listening · recording · thinking · speaking. The status
// element (#voiceStatus) shows the state word + colour; the button (#wakeBtn)
// shows what a TAP does right now. Both derive from HERE and nowhere else, so no
// two visible elements can report mic state independently (they can't disagree).
// The button label also carries the ENGINE distinction: a one-shot cloud/basic
// capture ends on SEND, an open Web-Speech session ends on CLOSE — so the driver
// always knows whether the next tap sends or closes, even though the state word
// and colour are shared. Any old "second indicator" is gone: #voiceBtn no longer
// carries its own listening styling, and setVoiceStatus/setListeningUI are gone.
let micState = 'off';   // 'off' | 'listening' | 'recording' | 'thinking' | 'speaking'
const MIC_META = {      // state → [status word, colour]
  off:       ['Off', 'red'], listening: ['Listening', 'green'], recording: ['Recording', 'green'],
  thinking:  ['Thinking', 'amber'], speaking: ['Speaking', 'amber'],
};
function setMicState(state) {
  if (!MIC_META[state]) state = 'off';
  if (state !== micState) logEvent('state', state);
  micState = state;
  const [word, colour] = MIC_META[state];
  // THE status element — five states, colour matches the button.
  const s = document.getElementById('voiceStatus');
  if (s) { s.textContent = word; s.className = 'voice-status mic-' + colour; }
  // THE button — label = the tap action NOW, including which engine is live.
  const capturing = cloudActive || captureActive;   // one-shot capture: a tap SENDS
  const session   = convoActive;                     // hands-free session: a tap CLOSES
  let label;
  if (state === 'off') label = '🎙 Tap to talk';
  else if (state === 'recording') label = capturing ? '🎙 Recording · tap to send' : '🎙 Recording · tap to close';
  else if (state === 'listening') label = '🎙 Listening · tap to close';
  else if (state === 'thinking') label = '🎙 Thinking…';
  else /* speaking */ label = session ? '🎙 Speaking · tap to close' : '🎙 Speaking…';
  const cls = state === 'off' ? 'convo-off' : (state === 'thinking' || state === 'speaking') ? 'convo-busy' : 'convo-on';
  const b = document.getElementById('wakeBtn');
  if (b) { b.textContent = label; b.className = 'wake-word-btn ' + cls; }
  // Cosmetic ring on the mic entry points — driven from HERE (not independent).
  const live = (state === 'listening' || state === 'recording');
  document.getElementById('homeMic')?.classList.toggle('listening', live);
  document.getElementById('inputRow')?.classList.toggle('listening', live);
}
// The one mic button (#wakeBtn). A tap does the right thing for whatever is live:
// send a one-shot capture, close a session, or (idle) open a session.
function micTap() {
  unlockAudio();
  if (cloudActive || captureActive) { stopCapture(true); return; }   // one-shot capture → send
  if (convoActive) { closeConversation('tap'); return; }             // session → close
  if (micState === 'thinking') return;                               // processing — ignore taps
  openConversation();                                                // idle → open a hands-free session
}

// ── VOICE ─────────────────────────────────────────────────────────────────────
// iOS blocks speech synthesis unless first triggered by a direct user tap.
// Fire a silent utterance on the first gesture to unlock the speaker.
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked || !synth) return;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    synth.speak(u);
    audioUnlocked = true;
  } catch(e) {}
}

// ── MIC CAPTURE — driver-controlled endpointing ──────────────────────────────
// Tap to open the mic, tap again to send. The line stays open through
// mid-thought pauses; it only closes itself after a long silence once real
// speech has been captured. Android's recogniser fires onend early no matter
// what continuous says, so when that happens mid-capture we immediately start
// another and stitch the transcripts together — the AI receives ONE utterance,
// never fragments.
let captureActive = false;     // the driver wants the mic open
// Stitching rule: the committed transcript holds FINAL results only. Interim
// text is shown live but is always REPLACED, never appended — appending it (or
// carrying it across a restart) is what produced "going back to going back to…".
let committedFinal = '';       // finals carried from PREVIOUS recogniser instances
let instanceFinal = '';        // finals from the CURRENT instance (rebuilt, not appended)
let interimText = '';          // current interim segment — replaced every result
let heardSpeech = false;       // has anything actually been said this capture
let silenceTimer = null;       // fires after a long silence, once speech exists
let noSpeechTimer = null;      // conversation-mode auto-sleep only
let restartBurst = 0;          // guards a recogniser that dies instantly
const SILENCE_MS = 2800;       // long enough to survive a mid-sentence breath

function toggleVoice() {
  unlockAudio();
  if (captureActive) stopCapture(true);   // tap-to-send — the primary endpoint
  else startListening();
}

// Everything committed so far, plus this instance's final and the live interim
// tail — MERGED, not concatenated. Android re-delivers audio across instances,
// so raw concatenation duplicates words both on screen and in what gets sent.
function capturedText() {
  return mergeFinal(mergeFinal(committedFinal, instanceFinal), interimText);
}
// Merge a newly-finalised chunk into the committed transcript without ever
// repeating words. Android hands the same audio to more than one recogniser
// instance, so a chunk may be a full re-hear (drop it) or overlap the tail of
// what we already have (stitch at the seam) — plain appending is what produced
// the repeated-fragment salad.
function mergeFinal(committed, addition) {
  const a = (committed || '').trim(), b = (addition || '').trim();
  if (!b) return a;
  if (!a) return b;
  const al = a.toLowerCase(), bl = b.toLowerCase();
  if (al.includes(bl)) return a;                 // already have it — a re-hear
  const max = Math.min(al.length, bl.length);
  for (let n = max; n > 3; n--) {                // longest tail/head overlap wins
    if (al.slice(-n) === bl.slice(0, n)) {
      return (a + b.slice(n)).replace(/\s+/g,' ').trim();
    }
  }
  return (a + ' ' + b).replace(/\s+/g,' ').trim();
}

function showCaptured(text) {
  const ui = document.getElementById('userInput');
  if (ui) { ui.value = text; try { autoResize(ui); } catch(e) {} }
}
// Only ever armed after real speech: a driver who hasn't spoken yet keeps the
// mic until they tap. Any new speech resets the clock, so pauses are safe.
function armSilenceTimer() {
  clearTimeout(silenceTimer);
  if (!heardSpeech) return;
  silenceTimer = setTimeout(() => { if (captureActive) stopCapture(true, 'silence'); }, SILENCE_MS);
}

let micGranted = false;   // true once the OS mic permission is confirmed granted
let micPending = false;   // a permission prompt is open — don't re-enter

// NEVER start the recogniser deaf. On iOS Safari the very first run has no mic
// permission yet; calling recognition.start() then starts a deaf recogniser that
// fails silently and only works after a full restart. So confirm the grant FIRST:
// getUserMedia shows the prompt and its promise resolves only when the user taps
// Allow — we wait for that, then open the recogniser. Returns true = clear to start.
async function ensureMicPermission() {
  if (micGranted) return true;
  // If the Permissions API already knows the answer, trust it (skips a re-prompt).
  try {
    if (navigator.permissions && navigator.permissions.query) {
      const st = await navigator.permissions.query({ name: 'microphone' });
      if (st.state === 'granted') { micGranted = true; return true; }
      if (st.state === 'denied') {
        setMicState('off');
        addMsg('nav', 'Microphone is blocked — allow it for this site in your browser settings, then tap the mic again.');
        return false;
      }
    }
  } catch (e) { /* Safari can't query 'microphone' — fall through to a real prompt */ }
  // Unknown or 'prompt': ask now and WAIT for the grant before starting.
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    addMsg('nav', 'I need the mic — tap Allow when the browser asks.');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());   // only needed the grant; SR opens its own
      micGranted = true;
      return true;
    } catch (e) {
      setMicState('off');
      addMsg('nav', 'I need the mic — tap Allow when the browser asks, or type it below.');
      return false;
    }
  }
  return true;   // no getUserMedia (very old browser) — let the recogniser try
}

// ── CLOUD EARS (V2) — record the audio, let the Worker transcribe it ─────────
// Everything here ends at deliverTranscript(), the same handoff Web Speech
// uses. If any step fails we log why and fall back to Web Speech for that turn.
let cloudActive = false;        // a recording is running
let mediaRecorder = null;
let mediaStream = null;
let recChunks = [];
let recMaxTimer = null;
let recAudioCtx = null;
let cloudSendWanted = true;     // did the driver want this turn sent?
let cloudEndReason = 'silence'; // how the cloud turn ended: silence · cutoff · tap
let pendingTurnEnd = null;      // one-shot end-reason for the NEXT sendMessage (voice only)
let recStartedAt = 0;           // when this recording began
let recVoiced = false;          // did the analyser ever hear actual speech?
let recAnalyserOn = false;      // ...and was the analyser running to judge that?
const REC_SILENCE_MS = 2800;    // ~2.8s of quiet ends the turn — matches SILENCE_MS
                                // so a mid-sentence breath doesn't cut the driver off
const REC_MAX_MS = 30000;       // hard stop — never record forever
const REC_MIN_MS = 700;         // shorter than this is a fumbled tap, not speech
const REC_SHORT_MS = 1500;      // "short enough that a stock phrase is suspect"

// Whisper HALLUCINATES on silence — it emits training-data boilerplate ("call
// ended", "thank you", "Subtitles by …") with full confidence. Those phrases
// must never reach the chat as if the driver said them. Only ever consulted
// when the audio was short or silent, so a real "thank you" still gets through.
const SILENCE_ARTEFACTS = [
  'call ended', 'thank you', 'thanks', 'thank you very much', 'thanks for watching',
  'thank you for watching', 'thanks for listening', 'please subscribe', 'subscribe',
  'like and subscribe', 'the end', 'you', 'music', 'applause', 'silence', 'bleep',
];
function isSilenceArtefact(text) {
  const t = cleanTranscript(text).toLowerCase().replace(/[^a-z0-9' ]/g, '').replace(/\s+/g,' ').trim();
  if (!t) return true;
  if (SILENCE_ARTEFACTS.includes(t)) return true;
  if (/^(subtitles?|captions?|transcriptions?|translations?)\b.*\b(by|provided|from)\b/.test(t)) return true;
  if (/amara\.?org|subscribe to|www\.|\.com$/.test(t)) return true;
  return false;
}

function cloudEarsSupported() {
  return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}
// iOS Safari records audio/mp4; Chrome/Firefox/Android record audio/webm.
// Ask for the one this browser actually supports, preferring its native format.
function pickRecordingMime() {
  const ua = navigator.userAgent;
  const isApple = /iPad|iPhone|iPod/.test(ua) || (/Safari/.test(ua) && !/Chrome|Chromium|Android|CriOS|FxiOS/.test(ua));
  const order = isApple ? ['audio/mp4', 'audio/webm'] : ['audio/webm', 'audio/mp4'];
  for (const m of order) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';   // nothing declared — let the browser pick its default
}

function releaseRecordingStream() {
  try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch(e) {}
  mediaStream = null;
  try { if (recAudioCtx) recAudioCtx.close(); } catch(e) {}
  recAudioCtx = null;
}

// End the turn after ~1.5s of quiet, but only once they've actually spoken —
// a driver still thinking keeps the mic until they tap.
async function armRecordingSilence() {
  try {
    if (!recAudioCtx) {
      // The gesture path didn't make one (e.g. conversation-mode auto-listen) —
      // try now; it may start suspended, which the discard logic accounts for.
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      recAudioCtx = new Ctx();
    }
    // iOS: resume BEFORE reading the analyser, or it stays suspended and flatlines.
    // If resume rejects, carry on — the meter just won't run, and the discard
    // logic will not treat that flatline as silence.
    try { await recAudioCtx.resume(); }
    catch (e) { console.warn('[cloud ears] AudioContext resume failed:', e && e.message); }
    if (!cloudActive) return;   // recording ended while we awaited the resume
    const src = recAudioCtx.createMediaStreamSource(mediaStream);
    const an = recAudioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    recAnalyserOn = true;   // we CAN judge silence this turn
    let spoke = false, quietSince = 0;
    const tick = () => {
      if (!cloudActive) return;
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i] - 128); if (v > peak) peak = v; }
      const now = Date.now();
      if (peak > 6) { spoke = true; recVoiced = true; heardSpeech = true; quietSince = 0; }
      else if (spoke) {
        if (!quietSince) quietSince = now;
        else if (now - quietSince >= REC_SILENCE_MS) { cloudEndReason = 'silence'; stopCloudCapture(true); return; }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch (e) {
    console.warn('[cloud ears] silence detection unavailable:', e && e.message, '— tap to send');
  }
}

async function startCloudCapture() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    console.warn('[cloud ears] mic stream failed:', e && e.name);
    return false;
  }
  const mime = pickRecordingMime();
  try {
    mediaRecorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime }) : new MediaRecorder(mediaStream);
  } catch (e) {
    console.warn('[cloud ears] MediaRecorder failed:', e && e.message);
    releaseRecordingStream();
    return false;
  }
  recChunks = [];
  cloudSendWanted = true;
  heardSpeech = false;
  recVoiced = false; recAnalyserOn = false; recStartedAt = Date.now();
  mediaRecorder.ondataavailable = ev => { if (ev.data && ev.data.size) recChunks.push(ev.data); };
  mediaRecorder.onstop = () => { finishCloudCapture(); };
  try {
    mediaRecorder.start();
  } catch (e) {
    console.warn('[cloud ears] recorder would not start:', e && e.message);
    releaseRecordingStream(); mediaRecorder = null;
    return false;
  }
  cloudActive = true; captureActive = true;
  showCaptured('');
  setMicState('recording');    // one-shot cloud capture is live — a tap SENDS
  armRecordingSilence();
  clearTimeout(recMaxTimer);
  recMaxTimer = setTimeout(() => { if (cloudActive) { cloudEndReason = 'cutoff'; stopCloudCapture(true); } }, REC_MAX_MS);   // hard cutoff — likely mid-word
  return true;
}

function stopCloudCapture(send) {
  if (!cloudActive) return;
  cloudActive = false; captureActive = false;
  cloudSendWanted = !!send;
  clearTimeout(recMaxTimer);
  try {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();   // onstop → finishCloudCapture
    else finishCloudCapture();
  } catch (e) {
    console.warn('[cloud ears] stop failed:', e && e.message);
    finishCloudCapture();
  }
}

// POST the blob to the Worker and read back { text }.
async function transcribeBlob(blob) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 20000);
  let r;
  try {
    r = await fetch(API_URL + 'transcribe', {
      method: 'POST',
      headers: { 'content-type': blob.type || 'audio/webm' },
      body: blob,
      signal: ctrl.signal,
    });
  } finally { clearTimeout(to); }
  let d = {};
  try { d = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((d && d.error) || ('HTTP ' + r.status));
  return (d && d.text) ? String(d.text).trim() : '';
}

// A discard is a dead end, not a fallback: say so and stop. Re-opening the mic
// (or handing to Web Speech) here would just re-record the same silence.
function nothingCaught() {
  showCaptured('');
  setMicState('off');
  addMsg('nav', "I didn't catch anything — tap to try again.");   // guidance lives in chat now
}

async function finishCloudCapture() {
  const chunks = recChunks; recChunks = [];
  const type = (mediaRecorder && mediaRecorder.mimeType) || pickRecordingMime() || 'audio/webm';
  // Was the silence analyser GENUINELY running? On iOS the AudioContext can stay
  // suspended (flatline meter), which must NEVER be read as silence. Check the
  // real context state BEFORE releaseRecordingStream() tears it down.
  const analyserRan = recAnalyserOn && !!recAudioCtx && recAudioCtx.state === 'running';
  mediaRecorder = null;
  releaseRecordingStream();
  if (!cloudSendWanted) { setMicState('off'); showCaptured(''); return; }
  const blob = new Blob(chunks, { type });
  const durationMs = recStartedAt ? (Date.now() - recStartedAt) : 0;
  // "Silent" is only trustworthy when the analyser was verified running. If the
  // context was suspended or the analyser never ran properly, DON'T discard on
  // that basis — send the audio and let Whisper judge, rather than binning speech.
  const nearSilent = analyserRan && !recVoiced;
  // Too short or too small are still safe to drop; near-silent only when verified.
  if (blob.size < 1024 || durationMs < REC_MIN_MS || nearSilent) {
    console.warn('[cloud ears] discarded before sending —',
      `${durationMs}ms, ${blob.size}b, voiced=${analyserRan ? recVoiced : 'unverified'}`);
    nothingCaught();
    return;
  }
  setMicState('thinking');
  try {
    const text = await transcribeBlob(blob);
    // Whisper answers silence with boilerplate. If the audio was short or we
    // never heard a voice, a stock phrase is a phantom — bin it, don't send it.
    if (text && isSilenceArtefact(text) && (nearSilent || durationMs < REC_SHORT_MS)) {
      console.warn('[cloud ears] discarded silence hallucination:', JSON.stringify(text),
        `(${durationMs}ms, voiced=${recAnalyserOn ? recVoiced : 'unknown'})`);
      nothingCaught();
      return;
    }
    if (text) { deliverTranscript(text, 'cloud', cloudEndReason); return; }   // deliverTranscript → thinking → send
    console.warn('[cloud ears] empty transcript — Web Speech for this turn');
  } catch (e) {
    console.warn('[cloud ears] /transcribe failed:', (e && e.message) || e, '— Web Speech for this turn');
  }
  if (('webkitSpeechRecognition' in window) || ('SpeechRecognition' in window)) startWebSpeechCapture();
  else setMicState('off');
}

// V2: RECORDING is the primary path — the phone's own recogniser is the weak
// link in a noisy cab (SPEC §4). Web Speech stays as the silent per-turn
// fallback whenever recording or the transcription round-trip fails.
async function startListening() {
  if (convoActive) return;   // a conversation session owns the mic — don't open a second one
  const hasWebSpeech = ('webkitSpeechRecognition' in window) || ('SpeechRecognition' in window);
  if (!hasWebSpeech && !cloudEarsSupported()) {
    alert('Voice not supported on this browser — type it instead.'); return;
  }
  if (captureActive || micPending) return;   // already live, or waiting on the prompt
  synth?.cancel();
  // Starting a fresh recording after the question went stale: drop it now so
  // this turn is a clean new query, not a late answer to something forgotten.
  if (pendingQuestion && !pendingIsFresh()) setPending(null);
  // iOS: create the silence-detection AudioContext NOW — synchronously, inside
  // the tap gesture and BEFORE any await — or Safari starts it suspended and the
  // analyser reads flatline. The mic stream is wired into it later, in
  // armRecordingSilence, which resumes it before reading.
  if (cloudEarsSupported() && !recAudioCtx) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) recAudioCtx = new Ctx();
    } catch (e) { recAudioCtx = null; }
  }
  // Gate on a confirmed mic grant so we never open a deaf recogniser (the iOS
  // first-run race). In steady state this resolves instantly (micGranted).
  micPending = true;
  const allowed = await ensureMicPermission();
  micPending = false;
  if (!allowed) { releaseRecordingStream(); resetVoiceUI(); return; }
  if (cloudEarsSupported()) {
    if (await startCloudCapture()) return;
    releaseRecordingStream();   // cloud didn't start — close the gesture-made context
    console.warn('[cloud ears] recording unavailable — Web Speech for this turn');
  }
  if (hasWebSpeech) startWebSpeechCapture();
  else { setMicState('off'); addMsg('nav', 'Mic unavailable on this browser — type it instead.'); }
}

function startWebSpeechCapture() {
  captureActive = true;
  committedFinal = ''; instanceFinal = ''; interimText = '';
  heardSpeech = false; restartBurst = 0;
  showCaptured('');
  startRecogniser();
}

function startRecogniser() {
  // Cut the previous instance loose first. A zombie recogniser still wired to
  // onresult would feed the same audio in alongside the new one — another way
  // to duplicate words.
  if (recognition) {
    try {
      recognition.onend = null; recognition.onresult = null; recognition.onerror = null;
      if (recognition.abort) recognition.abort(); else recognition.stop();
    } catch(e) {}
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = 'en-AU';
  recognition.continuous = true;       // hold the line through pauses
  recognition.interimResults = true;   // so partials can be shown and stitched

  recognition.onstart = () => { isListening = true; logEvent('rec.onstart', 'basic'); setMicState('recording'); };   // basic ears open — a tap SENDS

  recognition.onresult = e => {
    // Rebuild both segments from scratch every event (e.results is cumulative).
    // Android's cumulative results can contain DUPLICATE or overlapping items —
    // finals re-finalised, interims re-emitted — so fold each segment through
    // mergeFinal instead of a blind concat, or the same phrase repeats N times.
    let fin = '', interim = '';
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i], seg = (r[0] && r[0].transcript) || '';
      if (r.isFinal) fin = mergeFinal(fin, seg); else interim = mergeFinal(interim, seg);
    }
    instanceFinal = fin;      // deduped finals for this instance
    interimText  = interim;   // deduped interim tail — shown live, never committed here
    const combined = capturedText();
    if (combined) { heardSpeech = true; restartBurst = 0; }
    showCaptured(combined);            // the driver sees what's being heard
    armSilenceTimer();                 // speech resets the silence clock
  };

  recognition.onerror = e => {
    logEvent('rec.onerror', 'basic:' + (e && e.error));
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      captureActive = false;
      micGranted = false;   // permission was pulled — re-prompt on the next tap
      clearTimeout(silenceTimer); clearTimeout(noSpeechTimer);
      resetVoiceUI();
      addMsg('nav', 'Microphone is blocked — allow it for this site in your browser settings, then tap the mic again.');
    }
    // no-speech / network / aborted fall through to onend, which restarts
  };

  recognition.onend = () => {
    logEvent('rec.onend', 'basic');
    // Carry forward FINALS ONLY, merged overlap-aware. Android restarts often
    // re-deliver audio the previous instance already finalised, so a plain
    // append (or an endsWith guard, which only catches an immediate repeat)
    // rebuilds the word salad: "right so I'm in Cairns I'm gonna right so I'm
    // in Cairns". mergeFinal drops a re-heard chunk and stitches a partial
    // overlap instead of duplicating it.
    committedFinal = mergeFinal(committedFinal, instanceFinal);
    instanceFinal = ''; interimText = '';
    if (!captureActive) return;        // a deliberate stop — stopCapture sends
    // Android ended us early but the driver isn't finished: start another.
    restartBurst++;
    if (restartBurst > 12 && !heardSpeech) {
      stopCapture(false);
      addMsg('nav', 'Mic keeps dropping out — tap to try again, or type it.');
      return;
    }
    try { startRecogniser(); } catch(err) {
      setTimeout(() => { if (captureActive) { try { startRecogniser(); } catch(e2) {} } }, 250);
    }
  };

  try { recognition.start(); } catch(e) {
    // start() throws if the previous instance hasn't released yet — retry once
    setTimeout(() => { if (captureActive) { try { recognition.start(); } catch(e2) {} } }, 250);
  }
}

// THE handoff point. Every set of ears — Web Speech finals or a cloud
// transcript — arrives HERE and nowhere else, so nothing downstream knows or
// cares which engine heard it. Do not add a second route into sendMessage.
function deliverTranscript(text, source, endReason) {
  // Cloud transcription punctuates; the phone's recogniser doesn't. Normalise
  // once HERE so "Cardwell." and "Cardwell" are the same word everywhere after.
  text = cleanTranscript(text);
  if (text.length <= 1 || _isBusy()) return;
  // How the turn ended ('silence' natural · 'cutoff' force-ended · 'tap' driver
  // chose to send). sendMessage consumes it once to guard destination resolution
  // against fragments left by a hard cutoff. Not a second route — just metadata.
  pendingTurnEnd = endReason || 'silence';
  // DIAGNOSTIC (console only now): WHICH ears heard it — ☁️ cloud/Whisper vs
  // 📱 basic/Web Speech. The status element shows only the five mic states, so the
  // source tag no longer rides the status line (it stays in the console log).
  console.info('[ears] transcript via ' + (source === 'basic' ? 'BASIC (Web Speech)' : 'CLOUD (Whisper)') + ': ' + JSON.stringify(text));
  showCaptured(text);
  setMicState('thinking');   // heard — now processing
  logEvent('deliver', source + ':' + endReason);
  setTimeout(() => { if (!_isBusy()) _onTranscript(); }, 600);
}

// The single exit point: close the mic and send ONE combined utterance. `reason`
// records HOW the turn ended (default 'tap' — an explicit driver send).
function stopCapture(send, reason) {
  reason = reason || 'tap';
  if (cloudActive) { cloudEndReason = reason; stopCloudCapture(send); return; }   // recording path has its own stop
  captureActive = false;
  clearTimeout(silenceTimer); clearTimeout(noSpeechTimer);
  try { if (recognition) { recognition.onend = null; recognition.stop(); } } catch(e) {}
  // Committed finals + the last interim tail, counted once each.
  const text = capturedText();
  committedFinal = ''; instanceFinal = ''; interimText = '';
  resetVoiceUI();
  if (send) deliverTranscript(text, 'basic', reason);   // Web Speech = the basic ears
  else showCaptured('');
}

function resetVoiceUI() {
  isListening = false;
  recognition = null;
  if (!convoActive) setMicState('off');   // a live session keeps its own state
}

function stopListening() { stopCapture(true); }   // legacy name — same endpoint

// ── SPOKEN-REPLY QUEUE ──────────────────────────────────────────────────────
// A DEFAULT speak() cancels whatever is playing — the DRIVER's new turn interrupts
// current speech. But the app must NOT interrupt ITSELF: when it chains two replies
// in one turn (a trip brief, then the carried camps answer), the second must QUEUE
// and play in full AFTER the first (+ the normal tail), never cut it off mid-word.
// While draining the queue the mic stays shut until the LAST reply ends — no reopen
// between our own chained replies. Driver interrupts (cancelSpeech / a default
// speak) flush the queue.
let _ttsQueue = [];        // texts waiting to speak after the current one
let _ttsActive = false;    // an utterance is playing (or just handed to synth)
let _queueReplies = false; // while true, a new speak() ENQUEUES instead of cancelling
let _ttsNextTimer = null;  // deferred play of the next queued reply
function queueReplies(on) { _queueReplies = !!on; }

function speak(text) {
  if (!synth) return;
  // App-sequential reply while something is already playing → wait our turn.
  if (_queueReplies && _ttsActive) { _ttsQueue.push(text); return; }
  if (convoActive) { convoSpeaking = true; convoStopRecogniser(); }   // don't hear our own reply
  synth.cancel();
  _ttsQueue = [];            // a normal/interrupting speak supersedes anything pending
  _speakNow(text);
}

function _speakNow(text) {
  _ttsActive = true;
  let clean=text.replace(/\*\*(.*?)\*\*/g,'$1').replace(/\*(.*?)\*/g,'$1').trim();
  // Speak abbreviations as words — "300m" must not be read as "three hundred em"
  clean = clean
    .replace(/(\d)\s*km\b/gi, '$1 kilometres')
    .replace(/(\d)\s*m\b/g,  '$1 metres')
    .replace(/(\d)\s*c\/L\b/gi, '$1 cents a litre')
    .replace(/\bL\/100km\b/gi, 'litres per hundred kilometres');
  const utt=new SpeechSynthesisUtterance(clean);
  utt.lang='en-AU'; utt.rate=0.92; utt.pitch=1.0; utt.volume=1.0;
  const voices=synth.getVoices();
  const v=voices.find(v=>v.lang.startsWith('en-AU'))||voices.find(v=>v.lang.startsWith('en-GB'))||voices.find(v=>v.lang.startsWith('en'));
  if(v) utt.voice=v;
  utt.onstart = () => { logEvent('tts.start', ''); setMicState('speaking'); };
  utt.onerror = _afterSpeak;
  utt.onend = _afterSpeak;
  synth.speak(utt);
}

// Reply finished (or TTS failed). If more of OUR OWN replies are queued from the
// same turn, play the next after the tail WITHOUT reopening the mic. Otherwise a
// conversation session resumes listening on the SAME recogniser — no re-tap, no new
// SR(); a one-shot returns to Off. One path for both end + error so a failed
// utterance can't strand the session.
function _afterSpeak() {
  logEvent('tts.end', '');
  _ttsActive = false;
  if (_ttsQueue.length) {   // more of our own to say — keep the mic shut, play next after the tail
    clearTimeout(_ttsNextTimer);
    _ttsNextTimer = setTimeout(() => { if (convoActive) { convoSpeaking = true; convoStopRecogniser(); } _speakNow(_ttsQueue.shift()); }, CONVO_TTS_TAIL_MS);
    return;
  }
  if (!convoActive) { setMicState('off'); return; }
  convoHadExchange = true; convoRestarts = 0;
  // Do NOT reopen the mic the instant playback ends — the speaker is still emitting
  // the tail and the room echoes; the recogniser would hear the app's own reply,
  // finalise, restart and oscillate. Stay shut for a short tail, THEN resume.
  clearTimeout(convoResumeTimer);
  convoResumeTimer = setTimeout(() => {
    convoSpeaking = false;
    // convoStartRecogniser may close the session (reopen ceiling); re-check
    // convoActive before arming the silence timer so no stray timer survives.
    if (convoActive) { convoSetState('listening'); convoStartRecogniser(); if (convoActive) convoArmSilence(); }
  }, CONVO_TTS_TAIL_MS);
}

  // ── voices warm-up (was the index.html INIT line) ──────────────────────────
  if (synth) synth.onvoiceschanged = () => synth.getVoices();

  // ── PUBLIC API — the ONLY surface index.html may touch ─────────────────────
  function cancelSpeech() { _ttsQueue = []; _queueReplies = false; _ttsActive = false; clearTimeout(_ttsNextTimer); try { synth && synth.cancel(); } catch (e) {} }
  // Full voice shutdown for "start again" (was three lines in resetConversation:
  // cancel TTS, stop the basic recogniser if listening, close any live session).
  function voiceReset() {
    cancelSpeech();
    try { if (recognition && isListening) recognition.stop(); } catch (e) {}
    if (convoActive) closeConversation('reset');
  }
  // One-shot end-reason for the NEXT app send (was: read+null pendingTurnEnd).
  function takeTurnEnd() { const t = pendingTurnEnd; pendingTurnEnd = null; return t; }

  return {
    BUILD: '28 Jul 2026, 11:09 PM AEST',
    // sessions + capture
    openSession:  openConversation,
    closeSession: closeConversation,
    toggleCapture: toggleVoice,
    micTap:       micTap,
    reset:        voiceReset,
    // speech out
    speak:        speak,
    queueReplies: queueReplies,   // app-sequential replies queue (don't self-interrupt)
    cancelSpeech: cancelSpeech,
    unlockAudio:  unlockAudio,
    // state (read-only getters — no external writes to internals)
    state:         function () { return micState; },
    isSessionOpen: function () { return convoActive; },
    isCapturing:   function () { return cloudActive || captureActive; },
    // couplings
    onTranscript:  function (cb) { _onTranscript = (typeof cb === 'function') ? cb : function () {}; },
    setBusyGetter: function (fn) { _isBusy = (typeof fn === 'function') ? fn : function () { return false; }; },
    takeTurnEnd:   takeTurnEnd,
    // event log
    log:      function (kind, detail) { logEvent(kind, detail); },   // app-side entries (e.g. AI classify spike)
    getLog:   function () { return vlog.slice(); },
    clearLog: function () { vlog = []; try { if (typeof localStorage !== 'undefined' && localStorage) localStorage.removeItem(VLOG_KEY); } catch (e) {} },
  };
})();
