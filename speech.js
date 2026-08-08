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
const CONVO_MAX_CYCLES = 3;     // empty (no-delivery) reopens before an honest close (~15s at the field's ~5s churn cadence)
let convoUndelivered = 0;       // consecutive sub-healthy reopens with nothing delivered
let convoCycleHadSpeech = false;// did the CURRENT recogniser cycle see a genuine speechstart? progress = captured SPEECH, not a delivered turn
let convoReplyPending = false;  // a delivered turn's reply is being composed/spoken — NOT the driver's turn yet, so no-progress cycles are FREE until it finishes (tts.end + tail)
let convoLastStart = 0;         // when convoRec last started (for the alive-check + logging)
let convoRestarts = 0;          // consecutive reopens with NO capture — bounded, never infinite
let convoCued = false;          // close cue already played this session? (at most once)
let openCued = false;           // OPEN cue already played for the CURRENT driver-turn window? reset by setMicState whenever the mic leaves listening/recording (→ never re-fires on an internal restart, only on a genuine new turn)
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
// THE ENGINE PICK, as one predicate — shared by openConversation and the ONE-MIC
// delegation in toggleVoice (MIC-SIMPLE step 3): Android with the full cloud kit.
function cloudSessionPick() {
  return CS_ENABLED && CONVO_ANDROID && cloudEarsSupported() && !!(window.AudioContext || window.webkitAudioContext);
}
function openConversation() {
  // CS-SEAM (step 7) — THE ENGINE PICK. Android with the full cloud kit present
  // (MediaRecorder + getUserMedia + AudioContext) gets the CLOUD session; everything
  // else — including iOS, per the design report — keeps the Web-Speech session exactly
  // as shipped. CS_ENABLED is LIVE (step 9): Android + full kit sessions run cloud;
  // every other device falls straight through to openWebSpeechSession.
  const cloudPick = cloudSessionPick();
  if (CS_ENABLED) logEvent('engine', cloudPick ? 'cloud' : 'webspeech');   // the PICK — the first line of every session in the field log
  if (cloudPick) { csOpen(); return; }
  openWebSpeechSession();
}
// The Web-Speech session open — the original body, unchanged. Also the SWAP TARGET
// when the cloud engine can't open or fails mid-session (pathology guards live here).
function openWebSpeechSession() {
  if (!convoSupported()) {
    const m = "This browser can't do hands-free listening — tap the mic for each question.";
    addMsg('nav', m); lastSpoken = m; speak(m); return;
  }
  try { const Ctx = window.AudioContext || window.webkitAudioContext; if (Ctx && !convoAudioCtx) convoAudioCtx = new Ctx(); convoAudioCtx && convoAudioCtx.resume && convoAudioCtx.resume(); } catch(e) {}
  unlockAudio();
  try { if (captureActive) stopCapture(false); } catch(e) {}   // don't let two mics fight
  logEvent('open', 'session');
  convoActive = true; convoOffered = false; convoHadExchange = false; offerAnswerPending = false; lastSessionCancelAt = 0;
  convoRestarts = 0; convoCued = false; convoLastError = '';
  convoTurn = ''; convoDelivered = ''; clearTimeout(convoDeliverTimer);   // fresh turn accumulator
  convoFlips = 0; convoLastState = ''; convoUndelivered = 0; convoCycleHadSpeech = false; convoReplyPending = false; clearTimeout(convoResumeTimer);    // fresh oscillation guards
  convoSetState('listening');       // session open, waiting for speech
  convoStartRecogniser();          // creates + starts convoRec IN the gesture
  convoUndelivered = 0;            // the opening start is not an "undelivered reopen" — only reopens AFTER open count toward the churn ceiling
  if (convoActive) convoOpenCue(); // audible RISING cue — the session just opened for the driver
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
  // NOT the driver's turn yet: a delivered turn is still being composed (thinking) or the
  // reply is playing (TTS + tail). Those cycles are the APP's doing, not idle driver churn,
  // so they NEVER count toward the no-progress ceiling — the counter is suspended across
  // deliver → reply-finished (field 4D6EDK9: a ~14s compose gap ran the ceiling to 3 and
  // closed the session before the reply even played). Genuine post-reply idle still counts.
  if (convoReplyPending || convoSpeaking || _isBusy()) return false;
  // Progress = genuine CAPTURED SPEECH this cycle, not a delivered turn. A cycle in which
  // the driver actually spoke (rec.speechstart fired) is real progress even if the engine
  // restarted mid-utterance before the pause — it must NOT count toward the no-progress
  // ceiling, or a long answer spanning engine restarts gets closed on mid-speech (field
  // 9XJ9UWR, 145-151s). Cycles with only ambient onresult text — or none at all (the
  // earcon beep loop) — never fire speechstart, so they still accumulate and close honestly.
  if (convoCycleHadSpeech) {
    convoCycleHadSpeech = false;   // consume; the next cycle must re-earn it with real speech
    convoUndelivered = 0;
    logEvent('reopen', 'progress');
    return false;
  }
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
    convoRec.onspeechstart = () => { if (convoSpeaking) return; logEvent('rec.speechstart', 'convo'); convoCycleHadSpeech = true; convoReplyPending = false; convoFlips = 0; convoArmSilence(); if (convoActive) convoSetState('recording'); };  // genuine speech onset is real input, NOT echo churn — it marks THIS reopen cycle as progress (so a driver speaking across engine restarts is never closed on) and must never be the flip that trips the oscillation ceiling (the field close-on-speechstart bug). Ambient-only cycles (no speechstart) still bound a real restart loop.
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
      // NOTE: onresult GROWTH alone does NOT reset any ceiling — ambient noise the
      // engine finalises grows convoTurn too, and resetting on it let the echo loop
      // run forever. The reopen ceiling clears on a genuine speechstart cycle (real
      // captured speech — see convoNoteReopen) or a delivered turn; the flip ceiling
      // clears only on speechstart / a delivered turn. Never on growth alone.
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
      // A recogniser that stayed alive past CONVO_HEALTHY_MS wasn't RAPID-restarting, so
      // clear the rapid-restart backoff counter. Do NOT clear convoUndelivered on alive
      // time: a long-alive recogniser that delivered NOTHING is still an undelivered
      // reopen. Clearing it here was the leak — at the field's ~5s churn cadence every
      // cycle was "alive" (>2s) and reset the ceiling, so the beep loop ran unbounded
      // (13 cycles / 70s). convoUndelivered now clears ONLY on a real delivered turn (and
      // at open), so a no-delivery churn climbs to the cap and closes within ~15s.
      if (alive >= CONVO_HEALTHY_MS) convoRestarts = 0;
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
  convoFlips = 0; convoUndelivered = 0; convoCycleHadSpeech = false; convoReplyPending = true;   // a delivered turn is real progress — clear the oscillation guards + the cycle-speech credit, and mark a reply pending so the compose/TTS gap can't run the no-progress ceiling
  convoHandleUtterance(pending, 'silence');            // a session turn always ends on a pause
}
function convoHandleUtterance(text, endReason) {
  if (isClosePhrase(text)) { closeConversation('phrase'); return; }   // pre-busy early check (convo)
  deliverTranscript(text, 'basic', endReason || 'silence');   // normal pipeline; the reply's speak() pauses us
}
// ── OFFER-NO (field GHR8TSM): a NEGATIVE answer to "Anything else?" ends the session ─
// The offer context can't ride csOffered/convoOffered — the answer's own speech resets
// those via the arm-silence calls before delivery — so this flag is set when either
// engine's offer speaks and CONSUMED by the first delivered turn (or any close/open).
// Scoped to that one turn: a "no" answering the APP's question mid-exchange is an
// ordinary turn, never a close.
let offerAnswerPending = false;
function isOfferNo(text) {
  const t = cleanTranscript(text).toLowerCase().replace(/[.!?,\s]+$/, '').trim();
  return t.length <= 30 && /^(?:no|nope|nah|no thanks?|no thank you|that'?s (?:all|it)|nothing(?: else)?|i'?m good|all good)(?:[\s,]+(?:mate|thanks?|thank you|cheers))?$/.test(t);
}
// CS-CLOSE-WORDS (field 2WYPVSZ): the close vocabulary is the plain words a driver
// reaches for, FULL-MATCH only — anchored ^…$ with a bounded courtesy tail and a 30-char
// cap, so "close" inside "closest caravan park" or "stop" inside "should I stop at
// Ingham" can never end a session. Serves BOTH engines (the shared deliverTranscript
// seam) plus convo's early pre-busy check.
function isClosePhrase(text) {
  const t = cleanTranscript(text).toLowerCase().replace(/[.!?,\s]+$/, '').trim();
  return t.length <= 30 && /^(?:that'?s (?:it|all)|that is all|thanks|thank you|cheers|done|all done|i'?m (?:all )?(?:done|finished)|no that'?s it|that will do|bye|goodbye|close|end (?:the )?chat|end (?:the )?conversation|finish(?:ed)?|we'?re finished|stop(?: listening)?|shut down|over and out)(?:[\s,]+(?:mate|thanks?|thank you|cheers|now|please))?$/.test(t);
}
// A TRAILING "cancel that" / "scratch that" / "forget that" bins the whole utterance — no reply,
// no routing. Trailing only (the phrase must END the transcript), so a mid-sentence mention
// ("cancel that booking and…") does NOT trigger it. Punctuation-insensitive.
function isCancelPhrase(text) {
  const t = cleanTranscript(text).toLowerCase().replace(/[.!?,\s]+$/, '');
  return /\b(cancel|scratch|forget) that$/.test(t);
}
// CANCEL a capture in progress (the red ✕ that replaces the send arrow while recording). Discards
// the utterance — nothing transcribed, delivered or replied to — plays the neutral blip, and then:
// one-shot → the mic closes; a session → stays OPEN and returns to a FRESH listening turn (one open
// cue as normal). A session rebuilds a fresh recogniser so the muddled cumulative results can't
// re-deliver as the next turn.
// CS-X-ESCAPE (fields 2WYPVSZ + EBQFG6V: nine ✕ in 22s, then seven in 5s): to a driver,
// cancel-then-chirp-open-again reads as "the app refuses to shut". A SECOND session-cancel
// within X_ESCAPE_MS — with no delivered turn between the two — means they want OUT: close
// the session with the sign-off, one close cue, and its own logged reason. Any delivered
// turn resets the pattern, so cancel → a real turn → a later cancel never trips it. TAP
// cancels only (a spoken "scratch that" is deliberate wording, never a stuck driver); the
// one-shot ✕ is untouched.
const X_ESCAPE_MS = 3000;
let lastSessionCancelAt = 0;
function xEscapeTripped() {
  const now = Date.now();
  const tripped = (now - lastSessionCancelAt) <= X_ESCAPE_MS && lastSessionCancelAt > 0;
  lastSessionCancelAt = now;
  return tripped;
}
function cancelCapture() {
  // CLOUD session cancel (CS-CANCEL, flag-gated — csActive needs CS_ENABLED): bin the open
  // window outright (nothing uploads), blip, and open a FRESH turn window — session stays
  // open. Sane no-ops: during TTS/tail/offer, or with no window running, there is NOTHING
  // to discard — no blip spam, no double windows (the pending resume owns the reopen). The
  // 45s close is deliberately NOT re-armed — only voiced speech resets the clocks. One-shot
  // state (cloudActive/captureActive/recognition) is never touched: the cs isolation rule.
  if (csActive) {
    if (csSpeaking || !csRec) return;
    if (xEscapeTripped()) { closeConversation('x-escape'); return; }   // second ✕ inside the window — get them OUT (no blip; the close cue + sign-off carry it)
    logEvent('cancel', 'tap-session');
    cancelBlip();
    csDiscardWindow('cancel');
    openCued = false;                    // the fresh turn earns a new open cue, exactly as convo's cancel does
    csStartWindow();
    return;
  }
  const wasSession = convoActive;
  if (!(cloudActive || captureActive || wasSession)) return;   // nothing recording → no-op
  if (wasSession && xEscapeTripped()) { closeConversation('x-escape'); return; }   // the same escape on the convo engine — the seam is shared
  logEvent('cancel', wasSession ? 'tap-session' : 'tap-oneshot');
  cancelBlip();
  if (cloudActive || captureActive) stopCapture(false);        // one-shot: stop WITHOUT sending → discarded, mic off
  if (wasSession) {
    clearTimeout(convoDeliverTimer);
    convoTurn = ''; convoDelivered = '';                       // drop the half-heard turn
    convoFlips = 0; convoUndelivered = 0; convoLastState = ''; convoReplyPending = false; convoCycleHadSpeech = false;
    if (convoRec) { try { convoRec.onend = null; convoRec.onerror = null; convoRec.onresult = null; convoRec.abort ? convoRec.abort() : convoRec.stop(); } catch (e) {} }
    convoRec = null; convoRecRunning = false;                  // fresh instance next start → muddled results gone
    openCued = false;                                          // the fresh turn earns a new open cue
    if (convoActive) { convoSetState('listening'); convoStartRecogniser(); convoOpenCue(); convoArmSilence(); }
  }
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
  offerAnswerPending = true;   // the NEXT delivered turn answers the offer (a negative closes)
  logEvent('offer', 'anything-else');
  convoSpeaking = true; convoStopRecogniser(); setMicState('speaking');
  // Same echo discipline as speak(): stay shut through a tail, THEN reopen.
  // The offer is a deliberate fresh listening window for the driver's ANSWER: clear the
  // oscillation guards on resume so the answer's speech onset can never be the flip/reopen
  // that trips a ceiling (the field close-fired-exactly-on-speechstart bug). The offer
  // fires at most once per quiet spell, so this can't be gamed into masking a real churn.
  const resume = () => { clearTimeout(convoResumeTimer); convoResumeTimer = setTimeout(() => { convoSpeaking = false; if (convoActive) { convoFlips = 0; convoUndelivered = 0; convoLastState = ''; convoSetState('listening'); convoStartRecogniser(); if (convoActive) convoOpenCue(); } }, CONVO_TTS_TAIL_MS); };   // "anything else?" spoken → mic reopens for the driver → RISING cue (once)
  try {
    synth && synth.cancel();
    const u = new SpeechSynthesisUtterance('Anything else?');
    u.lang = 'en-AU'; u.rate = 0.95;
    u.onend = resume;    // resume; do NOT re-arm
    u.onerror = resume;
    synth ? synth.speak(u) : resume();
  } catch (e) { resume(); }
}

// A short RISING tone so a driver not looking at the screen HEARS the moment the mic opens
// for them (field 31 Jul: the "Listening" label is invisible while driving). Deliberately the
// opposite character to the close cue (which falls): this glides UP. Fires ONLY from the genuine
// turn-start call sites (session open, one-shot start, reply/offer-end reopen) — NEVER from the
// onstart/reopen churn path. Two hard guards from the beep-loop history: (1) openCued caps it at
// ONE per driver-turn window (setMicState clears the flag only when the mic leaves listening/
// recording, so an internal restart that re-enters 'listening' can't re-fire it); (2) the mic must
// currently BE open for the driver (listening/recording) — so it's silent during TTS ('speaking'),
// thinking ('thinking') and after a close ('off'). Logged as `cue open`, mirroring the close cue.
// A short MELODIC cue — three quick sine notes so it carries over road noise (the single ding
// was easy to miss), phone-assistant style, well under half a second. RISING for open, the SAME
// notes DESCENDING for close. Same WebAudio + volume ballpark as the old single tone — only the
// SOUND changed; every firing rule and guard below is untouched.
function playCueMelody(freqs) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = convoAudioCtx || (Ctx && new Ctx());
    if (!ctx) return; convoAudioCtx = ctx;
    const t0 = ctx.currentTime, step = 0.11, dur = 0.13;   // 3 notes → ~0.35s total, under half a second
    freqs.forEach((f, i) => {
      const t = t0 + i * step;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(f, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.02);   // same volume ballpark as the old ding
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    });
  } catch (e) {}
}
const CUE_OPEN_NOTES  = [523.25, 659.25, 783.99];   // C5·E5·G5 — RISING (it just became the driver's turn)
const CUE_CLOSE_NOTES = [783.99, 659.25, 523.25];   // G5·E5·C5 — the same three notes DESCENDING (mic closed)

function convoOpenCue() {
  if (openCued) return;                                              // at most ONE per driver-turn window — never per restart
  if (micState !== 'listening' && micState !== 'recording') return;  // only when the mic is genuinely open for the driver (never TTS/thinking/off)
  openCued = true;
  logEvent('cue', 'open');
  playCueMelody(CUE_OPEN_NOTES);   // rising three-note sequence
}

// Descending three-note cue so a driver not looking at the screen knows the session closed.
// Uses the gesture-created AudioContext, so it sounds even on a timer-driven close.
function convoCloseCue() {
  if (convoCued) return;   // at most ONE close cue per session — never per restart
  convoCued = true;
  logEvent('cue', 'close');
  playCueMelody(CUE_CLOSE_NOTES);   // the same notes, descending
}

// A brief NEUTRAL blip (deliberately not the melodic cue) confirming a capture was binned by CANCEL.
function cancelBlip() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = convoAudioCtx || (Ctx && new Ctx());
    if (!ctx) return; convoAudioCtx = ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'square'; o.frequency.setValueAtTime(300, t);   // low, flat, square — clearly NOT the sine melody
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.connect(g); g.connect(ctx.destination);
    o.start(t); o.stop(t + 0.13);
  } catch (e) {}
}

function releaseConvoStream() { try { if (convoStream) convoStream.getTracks().forEach(t => t.stop()); } catch(e) {} convoStream = null; }

// STAYS-SHUT-2 (field HWDXWWT): a shut-up tap must stop the SOUND ITSELF, instantly —
// cs.close:tap at 1334.22s with tts.end at 1350.59s was sixteen seconds of talking after
// the driver said stop. And nothing may open a session except the driver's own action:
// the one self-opener (the after-call reopen) is gated through requestSession below.
let selfOpenArmed = true;    // stood down by a shut-up; re-armed by the driver's next tap or word
let _allowSignOff = false;   // one-shot: a close's own short sign-off is an acknowledgment, not a late reply
// ── CARRY-ON (field 7 Aug): a spoken answer the driver CUT is PARKED, not killed — the
// one exception to STAYS-SHUT (he asked for it; he interrupted it; he can have it back).
// Continue-words bind to it deterministically and NEVER reach the AI. Restart point per
// the driver's spec: ~1–1.5s (4–6 words) before the cut. Position comes from TTS word-
// boundary events where the engine emits them; Android Chrome historically does NOT, so
// the fallback estimates the cut from elapsed time (~13 chars/s at our rate), word-
// snapped; with neither, the whole answer re-speaks. Freshly-cut only (5 min); any new
// utterance supersedes the parked one.
let parkedAnswer = null;      // { text, charIndex|null, elapsed, at }
let _currentUttText = '', _speakStartedAt = 0, _boundariesSeen = false, _spokenCharIndex = 0;
const PARKED_TTL_MS = 5 * 60 * 1000;
function isContinuePhrase(text) {
  const t = cleanTranscript(text || '').toLowerCase().replace(/[.!?,\s]+$/, '').trim();
  return t.length <= 40 && /^(?:(?:can|could) you )?(?:carry on|continue|keep going|resume|go on|as you were)(?: with)?(?: that| it| the answer)?(?:,? please)?$/.test(t);
}
function parkCurrentSpeech() {
  if (!_ttsActive || !_currentUttText) return;
  parkedAnswer = { text: _currentUttText, charIndex: _boundariesSeen ? _spokenCharIndex : null, elapsed: Date.now() - _speakStartedAt, at: Date.now() };
}
// Public: try to resume the parked answer for this utterance. True = handled (re-spoken);
// false = not a continue-word / nothing freshly parked — the caller routes normally, which
// is what keeps the app-open trip-resume machinery's "resume" untouched.
function resumeSpeech(text) {
  if (!parkedAnswer || (Date.now() - parkedAnswer.at) > PARKED_TTL_MS) return false;
  if (!isContinuePhrase(text)) return false;
  const p = parkedAnswer; parkedAnswer = null;
  let idx = null, mode = 'whole';
  if (p.charIndex != null) { idx = p.charIndex; mode = 'boundary'; }
  else if (p.elapsed != null && p.elapsed > 0) { idx = Math.min(p.text.length, Math.round((p.elapsed / 1000) * 13)); mode = 'estimate'; }
  let tail = p.text;
  if (idx != null) {
    idx = Math.max(0, idx - 24);                        // ~1–1.5s ≈ 4–6 words back
    const sp = p.text.lastIndexOf(' ', idx);            // snap to a word start
    tail = p.text.slice(sp >= 0 ? sp + 1 : 0);
    if (!tail.trim()) { tail = p.text; mode = 'whole'; }
  }
  logEvent('resume.speech', mode);
  selfOpenArmed = true;   // the resume IS a driver request — it must never die under a prior shut-up's stand-down
  speak(tail);
  return true;
}
function shutUp() {
  parkCurrentSpeech();          // CARRY-ON: the cut answer is parked before the audio dies
  cancelSpeech();            // the audio dies mid-word, queue and all
  selfOpenArmed = false;     // the self-opener stands down until the driver acts
  try { if (window._onShutUp) window._onShutUp(); } catch (e) {}   // the app drops late replies too
}
function closeConversation(reason) {
  if (reason === 'tap' || reason === 'x-escape') shutUp();   // the shut-up gestures — silence NOW
  // CS-SKELETON (flag-gated): a cloud session closes on its own path. csActive can
  // only ever be true when the engine pick chose cloud (CS_ENABLED live since step 9).
  if (csActive) { csCloseSession(reason); return; }
  const wasActive = convoActive;
  logEvent('close', reason + (wasActive ? '' : ' (noop)'));
  convoActive = false; convoSpeaking = false; convoRecRunning = false; offerAnswerPending = false;
  clearTimeout(convoSilenceTimer); clearTimeout(convoOfferTimer); clearTimeout(convoDeliverTimer); clearTimeout(convoResumeTimer);
  convoTurn = ''; convoDelivered = ''; convoFlips = 0; convoLastState = ''; convoUndelivered = 0; convoReplyPending = false;   // drop any half-heard turn / oscillation state
  if (convoRec) { try { convoRec.onend = null; convoRec.onerror = null; convoRec.onresult = null; convoRec.abort ? convoRec.abort() : convoRec.stop(); } catch(e) {} }
  convoRec = null;                       // fresh instance next session; alive across THIS one
  releaseConvoStream();
  setMicState('off');
  // CLOSE-ORDER (field 9 Aug): a SPEAKING close says its words FIRST — the falling cue
  // is the goodbye, so it plays LAST, after the sign-off completes (_afterSpeak fires
  // it via _closeCueAfterSpeak). Wordless/other closes keep the immediate cue.
  const signOff = wasActive && (reason === 'phrase' || reason === 'silence' || reason === 'offer-no' || reason === 'x-escape');
  if (wasActive && !signOff) convoCloseCue();
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
  } else if (signOff) {
    const m = 'Tap to talk.';
    _allowSignOff = true;   // the close acknowledgment bypasses the shut-up drop-guard once
    addMsg('nav', m); lastSpoken = m;
    if (synth) { _closeCueAfterSpeak = true; speak(m); }   // words → then the goodbye tone
    else { speak(m); convoCloseCue(); }                    // no TTS on this browser — cue alone
  }
}
function convoFailHonestly() { closeConversation('honest'); }

// ── ONE MIC STATE MACHINE — the SOLE writer of the mic indicator ─────────────
// Five states: off · listening · recording · thinking · speaking. The compact
// in-row button (#wakeBtn) is the ONE visible indicator: its label carries a short
// state WORD, its class carries the colour. It derives from HERE and nowhere else,
// so nothing can report mic state independently. micTap still does the right thing
// for whatever is live (send a one-shot capture, close a session, or open one) —
// the label no longer spells that out ("· tap to send/close" dropped when the bar
// was folded into the input row). The separate #voiceStatus line is gone; #voiceBtn
// (the in-row one-shot mic, grouped with Hands-free on the left) is a NEUTRAL tap
// target — it never reports state, setMicState does — and setVoiceStatus/setListeningUI are gone.
let micState = 'off';   // 'off' | 'listening' | 'recording' | 'thinking' | 'speaking'
const MIC_META = {      // state → [driver word, colour] (LABELS-TRIM: two labels only)
  off:       ['Tap to talk', 'red'], listening: ['Listening', 'green'], recording: ['Listening', 'green'],
  thinking:  ['', 'amber'], speaking: ['', 'amber'],
};
function setMicState(state) {
  if (!MIC_META[state]) state = 'off';
  if (state !== micState) logEvent('state', state);
  micState = state;
  // OPEN-cue window boundary: leaving the driver's listening/recording window (to off/thinking/
  // speaking) arms the next open cue; staying within it (a listening<->recording flip, or an
  // internal restart that re-enters 'listening') does NOT — so churn can never re-trigger the cue.
  if (state !== 'listening' && state !== 'recording') openCued = false;
  // THE button is now the SOLE mic indicator, and it lives IN the input row (compact, no
  // full-width bar). The label answers the driver's ONE question in plain words (colour
  // and the pulse ride in the classes); idle INSTRUCTS (tap to talk). This drops the
  // old "· tap to send / tap to close" engine hint — too long for the in-row button — but
  // the tap still does the right thing (micTap), and the colour + word carry the state.
  // LABELS-TRIM (driver ruling, 9 Aug): TWO labels only, glanceable — hearing →
  // "Listening" · closed → "Tap to talk" (the instruction). The busy amber state is
  // WORDLESS: the field read "Wait…" as "white" ("I'm not waiting for anything");
  // the amber colour + pulse carry it alone, the glyph stays.
  let label;
  if (state === 'off') label = '🎙 Tap to talk';
  else if (state === 'recording' || state === 'listening') label = '🎙 Listening';
  else /* thinking | speaking */ label = '🎙';
  const cls = state === 'off' ? 'convo-off' : (state === 'thinking' || state === 'speaking') ? 'convo-busy' : 'convo-on';
  // GREEN-SIGNAL (MIC-SIMPLE step 1): ONE rule — GREEN MEANS IT CAN HEAR YOU. The binary
  // (mic-hearing = listening+recording collapsed · mic-busy = thinking/speaking ·
  // mic-closed = off) is stamped on EVERY mic surface from this one place, so no two
  // surfaces can ever disagree again (field 7 Aug: the wake button glowed green while
  // the home mic glowed RED for the same state). Classes + CSS only — zero behaviour.
  const bin = (state === 'listening' || state === 'recording') ? 'mic-hearing'
            : (state === 'thinking' || state === 'speaking') ? 'mic-busy' : 'mic-closed';
  const b = document.getElementById('wakeBtn');
  if (b) { b.textContent = label; b.className = 'wake-word-btn ' + cls + ' ' + bin; }
  // The SEND arrow doubles as a CANCEL control WHILE a capture is recording: a red ✕ during
  // 'recording' (one-shot or a session turn), back to the send arrow ➤ otherwise. The tap action
  // branches in the app's sendOrCancel (Voice.state()==='recording' → cancelCapture, else send).
  const sendEl = document.getElementById('sendBtn');
  if (sendEl) { const rec = (state === 'recording'); sendEl.textContent = rec ? '✕' : '➤'; sendEl.classList.toggle('cancel', rec); }
  // Cosmetic ring on the mic entry points — driven from HERE (not independent). The
  // legacy 'listening' hook stays toggled (its red CSS is retired); the binary rides
  // alongside on both surfaces.
  const live = (state === 'listening' || state === 'recording');
  ['homeMic', 'inputRow'].forEach(id => {
    const s2 = document.getElementById(id);
    if (!s2 || !s2.classList) return;
    s2.classList.remove('mic-hearing', 'mic-busy', 'mic-closed');
    s2.classList.add(bin);
    s2.classList.toggle('listening', live);
  });
}
// The one mic button (#wakeBtn). A tap does the right thing for whatever is live:
// send a one-shot capture, close a session, or (idle) open a session.
function micTap() {
  unlockAudio();
  selfOpenArmed = true;   // any driver tap re-arms (STAYS-SHUT-2)
  try { if (window._onDriverTap) window._onDriverTap(); } catch (e) {}
  if (cloudActive || captureActive) { stopCapture(true); return; }   // one-shot capture → send
  if (csActive) {
    // TAP-SEMANTICS (field TYPN9Z4, amended): THINKING (an upload/answer in flight) —
    // never bin a reply the driver already paid for: deliver it, THEN close (the latch;
    // that close logs 'tap-deferred'). EVERY other live state — listening, recording,
    // speaking — the tap is the off-switch: instant close, falling cue, no sign-off,
    // audio killed mid-word when something is playing (STAYS-SHUT-2).
    if (micState === 'thinking') { csCloseAfterDeliver = true; logEvent('cs.tap', 'deliver-then-close'); return; }
    closeConversation('tap');
    return;
  }
  if (convoActive) { closeConversation('tap'); return; }             // fallback engine: tap = close (unchanged)
  // SELF-OPENER (field MY3C5NL): with nothing live but a ONE-SHOT answer still SPEAKING,
  // a tap means STOP THE SOUND — never "open a session". The four "self-opens" at
  // 477/1999/2039/3654s were THIS fallthrough reading a shut-up tap as idle→open (the
  // only other open paths are requestSession, gated dead during TTS, and dead code).
  if (_ttsActive || micState === 'speaking') { parkCurrentSpeech(); cancelSpeech(); logEvent('tts.stop', 'tap'); setMicState('off'); return; }   // parked, not killed (CARRY-ON)
  if (micState === 'thinking') return;                               // processing — ignore taps
  openConversation();                                                // a TRULY idle tap → open a hands-free session
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
let basicProgressAt = 0;       // last time the basic recogniser CAPTURED new words (real progress)
const SILENCE_MS = 2800;       // long enough to survive a mid-sentence breath
const BASIC_CHURN_MS = 15000;  // restart churn with no NEW captured words this long -> stop honestly (matches the convo ceiling; bounds BOTH engines)

function toggleVoice() {
  // ONE-MIC (MIC-SIMPLE step 3, field 8 Aug): on Android with the full cloud kit,
  // EVERY mic is the same mic — a one-shot entry point (home mic, small round mic)
  // opens the SESSION through micTap's shipped tap table instead, so one tap anywhere
  // gives the ear that stays open. micTap also covers a live one-shot capture
  // (tap-to-send) and every session state, so the delegation is unconditional under
  // the pick. The one-shot body below stays as the iOS/desktop default and the
  // internal fallback.
  if (cloudSessionPick()) { micTap(); return; }
  unlockAudio();
  selfOpenArmed = true;   // a driver tap (STAYS-SHUT-2)
  try { if (window._onDriverTap) window._onDriverTap(); } catch (e) {}
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

// ── VAD MONITOR (VAD-UNIT) — the ONE reusable level-watcher, for the one-shot path today
// and the cloud session engine next. Wires an analyser onto `stream` via `ctx` and watches
// the time-domain peak each animation frame:
//   onSpeech()  — every tick at/above the effective ONSET threshold (first one = speech began)
//   onQuiet(ms) — ONCE, when quiet has lasted `quietMs` since the last voiced tick; loop ends
// Hysteresis: once speech has begun, `hold` (default = onset) is the level that still counts
// as speaking — a lower hold keeps a trailing soft syllable inside the utterance instead of
// starting the quiet clock (the truncation class of bug). Adaptive noise floor (default OFF —
// the one-shot path keeps today's fixed thresholds exactly): a short calibration reads the
// ambient level, then a slow tracker follows it, and both thresholds ride ON TOP of the floor
// so cab drone can never read as speech. The loop stops when alive() goes false, when onQuiet
// fires, or via the returned stop(). Throws only synchronously (analyser wiring) — the caller
// treats that as "can't judge silence this turn".
function vadMonitor(stream, ctx, opts) {
  opts = opts || {};
  const onset = (opts.onset != null) ? opts.onset : 6;      // today's fixed peak threshold (strictly >)
  const hold = (opts.hold != null) ? opts.hold : onset;     // hysteresis hold level (default: no hysteresis)
  const quietMs = opts.quietMs || REC_SILENCE_MS;
  const adaptive = !!opts.adaptive;
  const alive = opts.alive || (() => true);
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Uint8Array(an.fftSize);
  let spoke = false, quietSince = 0, stopped = false;
  let floor = 0, calib = adaptive ? ((opts.calibrateTicks != null) ? opts.calibrateTicks : 5) : 0;
  const tick = () => {
    if (stopped || !alive()) return;
    an.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i] - 128); if (v > peak) peak = v; }
    if (calib > 0) {   // adaptive: the first few ticks only measure the ambient level
      floor = floor ? floor * 0.7 + peak * 0.3 : peak;
      calib--; requestAnimationFrame(tick); return;
    }
    if (adaptive && peak <= floor + onset) floor = floor * 0.98 + peak * 0.02;   // slow ambient drift
    const now = Date.now();
    if (peak > floor + (spoke ? hold : onset)) { spoke = true; quietSince = 0; if (opts.onSpeech) opts.onSpeech(); }
    else if (spoke) {
      if (!quietSince) quietSince = now;
      else if (now - quietSince >= quietMs) { stopped = true; if (opts.onQuiet) opts.onQuiet(now - quietSince); return; }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return { stop() { stopped = true; } };
}

// End the turn after ~2.8s of quiet (REC_SILENCE_MS — the original 1.5s cut truncated
// destination names), but only once they've actually spoken — a driver still thinking
// keeps the mic until they tap. The level-watching itself lives in vadMonitor; this
// wrapper owns the AudioContext + the one-shot state flags, configured for BYTE-IDENTICAL
// behaviour to the old inline loop (fixed 6-peak threshold, no hysteresis, no floor).
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
    vadMonitor(mediaStream, recAudioCtx, {
      quietMs: REC_SILENCE_MS,             // onset/hold/adaptive left at defaults — today's exact thresholds
      alive: () => cloudActive,
      onSpeech: () => { recVoiced = true; heardSpeech = true; },
      onQuiet: () => { cloudEndReason = 'silence'; stopCloudCapture(true); },
    });
    recAnalyserOn = true;   // we CAN judge silence this turn — set ONLY after the wiring succeeded
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
  convoOpenCue();              // one-shot mic actually started → RISING cue (once)
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

// ── CLOUD SESSION (CS-SKELETON, step 3 of the cloud-ears plan) ────────────────
// Hands-free on the CLOUD engine: ONE held mic stream for the whole session, a
// fresh MediaRecorder per turn WINDOW, vadMonitor segmentation, upload via
// transcribeBlob, delivery through deliverTranscript — the same seam as every
// other ears path. LIVE since step 9 (05 Aug 2026): CS_ENABLED is true, and the
// engine pick in openConversation routes Android-with-full-kit sessions here;
// everything else (iOS, no-kit, one-shot mics) keeps the shipped paths.
// Status + cues are LIVE (step 4): states route through setMicState (single status
// element, ✕ send-swap while recording) and the melodic cues fire through the SAME
// once-guards as the Web-Speech session (openCued per driver-turn window, convoCued
// per session). Speaking + rhythm are LIVE (step 5): speak() discards the open
// window and freezes the clocks; _afterSpeak's 600ms tail reopens a fresh window
// (multi-turn); the 20s "Anything else?" offer and 45s silence close run with the
// convo constants; the artefact filter judges VOICED time, not blob duration.
// Cancel is LIVE (step 6): the ✕ and a trailing spoken "scratch/cancel/forget that"
// both bin the current window/utterance (nothing uploads or routes), blip, and open
// a fresh turn window — the session stays open; the 45s close is NOT reset by a
// cancel. The SEAM is LIVE (step 7): openConversation picks the engine (Android +
// full cloud kit → cs; everything else, incl. iOS, → Web Speech); micTap closes a
// cs session like any other; a denied mic at open or CS_FAIL_MAX consecutive
// transcribe failures triggers the ONE honest swap (csSwapToWebSpeech) onto the
// Web-Speech session — cue suppressed because the exchange continues; no fallback
// available → honest close. Step 8 formalises the cs.* log kinds; step 9 flips
// CS_ENABLED on for the Android field trial.
const CS_ENABLED = true;    // LIVE (step 9, 05 Aug 2026): the Android field trial — the engine pick in openConversation gates everything
let csActive = false;       // cloud session open?
let csStream = null;        // the ONE held mic stream — the session owns it end to end
let csCtx = null;           // AudioContext feeding the VAD
let csRec = null;           // the CURRENT turn-window recorder (fresh per window)
let csChunks = [];
let csVad = null;           // running vadMonitor handle for the current window
let csVoiced = false;       // did THIS window hear genuine speech?
let csWindowStart = 0;
let csWindowTimer = null;   // rolling window bound (idle discard / voiced cutoff)
let csWinSeq = 0;           // window id — a stale VAD/timer callback can't end a newer window
let csSpeaking = false;     // app is speaking — the session must not hear (or upload!) itself
let csHadExchange = false;  // at least one reply this session (gates the offer, as convo does)
let csOffered = false;      // "anything else?" already made this quiet spell
let csSilenceTimer = null;  // 45s hard close (CONVO_CLOSE_MS — shared rhythm)
let csOfferTimer = null;    // 20s offer nudge (CONVO_OFFER_MS)
let csResumeTimer = null;   // deferred window reopen after TTS ends (CONVO_TTS_TAIL_MS)
let csFirstVoicedAt = 0;    // voiced-time bounds for THIS window (artefact rule uses SPEECH
let csLastVoicedAt = 0;     // time, not blob duration — the leading wait inflates duration)
const CS_WINDOW_MS = 45000; // no window grows past this (voiced → cutoff send; the 45s silence
                            // close beats a pure-idle window to the bound, so idle discard is
                            // now just the safety net for a close-less edge, e.g. VAD down)
const CS_FAIL_MAX = 3;      // consecutive transcribe failures before the ONE honest engine swap
let csDeliveredWin = 0;     // CS-DELIVER-ONCE: the last window id that DELIVERED — a duplicate finish for the same window can never deliver twice
let csFailStreak = 0;       // reset by any successful /transcribe round trip (and at open)
let csCloseAfterDeliver = false;   // TAP-SEMANTICS: a tap during thinking DEFERS the close until the answer has been given

// ONE honest engine swap, at most once per session — never silent, never a ping-pong
// (csOpen has exactly ONE caller, the engine pick in openConversation; no failure path
// re-enters it, and the Web-Speech session's own failures close honestly, not back to
// cloud). The cs side shuts cleanly WITHOUT the close cue — the EXCHANGE continues,
// only the engine changes (convoCued suppresses it; the convo open re-arms the guard).
// No fallback engine at all → this IS an ending: honest close, cue, established line.
function csSwapToWebSpeech(reason) {
  logEvent('cs.swap', reason);
  const noFallback = !convoSupported();
  if (csActive) {
    if (!noFallback) convoCued = true;                 // suppress the close cue only when the exchange continues
    csCloseSession(noFallback ? 'honest' : 'swap');
  }
  if (noFallback) {
    const m = "Hands-free listening won't hold on this browser — tap the mic for each question.";
    addMsg('nav', m); lastSpoken = m; speak(m);
    return;
  }
  const m = "Cloud listening isn't working right now — switching to the phone's own listening.";
  addMsg('nav', m); lastSpoken = m;
  openWebSpeechSession();                              // pathology guards live from here
  speak(m);                                            // spoken INSIDE the session: pauses, plays, resumes with the cue
}

async function csOpen() {
  if (csActive || convoActive || cloudActive || captureActive) return false;   // one mic owner at a time
  try {
    csStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    // Mic denied for the cloud engine at open — the honest swap: say so and carry the
    // exchange on the Web-Speech session (which asks for the mic its own way).
    logEvent('cs.open', 'denied');
    csSwapToWebSpeech('denied');
    return false;
  }
  try { const Ctx = window.AudioContext || window.webkitAudioContext; if (Ctx && !csCtx) csCtx = new Ctx(); } catch (e) { csCtx = null; }
  try { if (csCtx && csCtx.resume) await csCtx.resume(); } catch (e) {}
  csActive = true;
  convoCued = false;          // re-arm the once-per-session close cue (same guard as the Web-Speech session)
  csSpeaking = false; csHadExchange = false; csOffered = false; csFailStreak = 0; offerAnswerPending = false; lastSessionCancelAt = 0; csCloseAfterDeliver = false;
  logEvent('cs.open', 'session');
  setMicState('listening');
  csArmSilence();             // armed BEFORE the first window, so at a 45s tie the close beats the window bound
  csStartWindow();            // the first window fires the rising open cue
  return true;
}

// Session rhythm — the SAME numbers and wording as the Web-Speech session: nudge at
// 20s ("Anything else?", only once an exchange has happened), hard close at 45s.
// Reset on driver speech and on reply-end resume; FROZEN while the app speaks.
function csArmSilence() {
  clearTimeout(csSilenceTimer); clearTimeout(csOfferTimer);
  csOffered = false;
  if (csHadExchange) csOfferTimer = setTimeout(csOffer, CONVO_OFFER_MS);
  csSilenceTimer = setTimeout(() => csCloseSession('silence'), CONVO_CLOSE_MS);
}
// The OFFER — not a close: answering it is a normal turn; the 45s close keeps
// running underneath (deliberately NOT re-armed by the offer, exactly as convo).
function csOffer() {
  if (!csActive || csOffered) return;
  csOffered = true;
  offerAnswerPending = true;   // the NEXT delivered turn answers the offer (a negative closes)
  logEvent('offer', 'anything-else');   // same event kind as the Web-Speech session
  csSpeaking = true;
  csDiscardWindow('offer');             // whatever window was open is binned, never uploaded
  setMicState('speaking');
  const resume = () => { clearTimeout(csResumeTimer); csResumeTimer = setTimeout(() => { csSpeaking = false; if (csActive) csStartWindow(); }, CONVO_TTS_TAIL_MS); };
  try {
    synth && synth.cancel();
    const u = new SpeechSynthesisUtterance('Anything else?');
    u.lang = 'en-AU'; u.rate = 0.95;
    u.onend = resume;
    u.onerror = resume;
    synth ? synth.speak(u) : resume();
  } catch (e) { resume(); }
}

// Bin the CURRENT window outright — no finish, no upload, no restart. Used when the
// app starts speaking (never transcribe ourselves) and by the offer; the caller
// decides when a fresh window opens (reply-end tail / offer resume).
function csDiscardWindow(reason) {
  csWinSeq++;                                    // orphan this window's VAD + bound timer
  clearTimeout(csWindowTimer);
  try { if (csVad) csVad.stop(); } catch (e) {} csVad = null;
  try { if (csRec && csRec.state !== 'inactive') { csRec.onstop = null; csRec.stop(); } } catch (e) {}
  csRec = null; csChunks = [];
  if (reason) logEvent('cs.discard', reason);
}

// One turn WINDOW: recorder + VAD live together; the whole window (leading wait
// included) lands in one standalone blob, so a mistimed cut can never drop words.
function csStartWindow() {
  if (!csActive || csSpeaking) return;   // never open the mic while the app is talking
  if (csCloseAfterDeliver) { csCloseAfterDeliver = false; csCloseSession('tap-deferred'); return; }   // TAP-SEMANTICS: the answer's moment passed (fail/discard) — close as promised
  const win = ++csWinSeq;
  csChunks = []; csVoiced = false; csWindowStart = Date.now();
  csFirstVoicedAt = 0; csLastVoicedAt = 0;
  const mime = pickRecordingMime();
  try { csRec = mime ? new MediaRecorder(csStream, { mimeType: mime }) : new MediaRecorder(csStream); }
  catch (e) { logEvent('cs.window', 'recorder-failed'); csCloseSession('honest'); return; }
  csRec.ondataavailable = ev => { if (ev.data && ev.data.size) csChunks.push(ev.data); };
  csRec.start();
  logEvent('cs.window', win);
  setMicState('listening');   // waiting for the driver; genuine speech flips to recording
  // The SAME rising cue through the SAME guard as every other path: openCued is cleared
  // only when the mic leaves listening/recording (setMicState boundary), so an idle-window
  // rollover (state never left 'listening') stays silent, while a genuine reopen after a
  // thinking spell (upload/fail/artefact) earns exactly one cue. No new sounds.
  convoOpenCue();
  try {
    csVad = vadMonitor(csStream, csCtx, {
      quietMs: REC_SILENCE_MS,
      alive: () => csActive && csWinSeq === win,
      onSpeech: () => {
        csLastVoicedAt = Date.now();                       // voiced-time bounds for the artefact rule
        if (!csFirstVoicedAt) csFirstVoicedAt = csLastVoicedAt;
        csArmSilence();                                    // driver speech resets the 20s/45s clocks (as convo's onresult does)
        if (!csVoiced) { csVoiced = true; logEvent('cs.vad', 'speech'); setMicState('recording'); }
      },
      onQuiet: () => csEndWindow(true, 'silence'),
    });
  } catch (e) { csVad = null; logEvent('cs.vad', 'unavailable'); }   // no VAD → the window bound still ends it
  clearTimeout(csWindowTimer);
  csWindowTimer = setTimeout(() => {
    if (!csActive || csWinSeq !== win) return;
    if (csVoiced) csEndWindow(true, 'cutoff');   // still talking at the bound — send what we have
    else csEndWindow(false, 'idle');             // a silent window — discard locally, roll on
  }, CS_WINDOW_MS);
}

function csEndWindow(send, endReason) {
  if (!csActive) return;
  const win = csWinSeq;                          // THIS window's id (assigned at csStartWindow) — stamped into upload/deliver logs
  csWinSeq++;                                    // orphan this window's VAD/timer at once
  clearTimeout(csWindowTimer);
  try { if (csVad) csVad.stop(); } catch (e) {} csVad = null;
  const rec = csRec; csRec = null;
  const voiced = csVoiced, startedAt = csWindowStart;
  const voicedMs = csFirstVoicedAt ? (csLastVoicedAt - csFirstVoicedAt) : 0;   // SPEECH time, not blob duration
  const finish = () => {
    const chunks = csChunks; csChunks = [];
    const type = (rec && rec.mimeType) || pickRecordingMime() || 'audio/webm';
    csFinishWindow(win, chunks, type, voiced, Date.now() - startedAt, voicedMs, send, endReason);
  };
  try {
    if (rec && rec.state !== 'inactive') { rec.onstop = finish; rec.stop(); }
    else finish();
  } catch (e) { finish(); }
}

async function csFinishWindow(win, chunks, type, voiced, durationMs, voicedMs, send, endReason) {
  if (!csActive) return;
  const blob = new Blob(chunks, { type });
  // An idle / unvoiced / too-small window is discarded LOCALLY — never uploaded;
  // the session rolls straight on to a fresh window.
  if (!send || !voiced || blob.size < 1024 || durationMs < REC_MIN_MS) {
    logEvent('cs.discard', endReason + ':' + durationMs + 'ms');
    if (!csSpeaking) csStartWindow();
    return;
  }
  setMicState('thinking');
  logEvent('cs.upload', 'w' + win + ' ' + blob.size + 'b ' + voicedMs + 'ms');   // window id + size + VOICED time
  let text = '';
  try { text = await transcribeBlob(blob); }
  catch (e) {
    // A failed upload bins the window; the session listens on — until the streak hits
    // CS_FAIL_MAX consecutive failures, then the ONE honest swap to Web Speech.
    csFailStreak++;
    logEvent('cs.fail', ((e && e.message) || 'transcribe') + ' x' + csFailStreak);
    if (csFailStreak >= CS_FAIL_MAX) { csSwapToWebSpeech('transcribe'); return; }
    if (csActive && !csSpeaking) csStartWindow();
    return;
  }
  csFailStreak = 0;           // a successful round trip proves the service — the streak resets
  if (!csActive) return;
  // Whisper's silence boilerplate is judged on VOICED time (step-3 forward note,
  // resolved): a window's blob duration includes the leading wait, so the old
  // duration heuristic let a 0.2s "thank you" through inside a 4s window. A stock
  // phrase with real speech time behind it still delivers.
  if (!text || (isSilenceArtefact(text) && voicedMs < REC_SHORT_MS)) {
    logEvent('cs.discard', text ? 'artefact' : 'empty');   // an empty transcript is a different fact from a binned stock phrase
    if (!csSpeaking) csStartWindow();
    return;
  }
  // CS-DELIVER-ONCE (fields 2WYPVSZ + BXCG2P4: two deliver events 140ms apart off one
  // upload): a window DELIVERS AT MOST ONCE, whatever double-fires upstream. A duplicate
  // names its window in the field log and dies here.
  if (csDeliveredWin === win) { logEvent('cs.dupe', 'w' + win); return; }
  csDeliveredWin = win;
  deliverTranscript(text, 'cloud', endReason, 'w' + win);   // → thinking → the app; the same seam as every ears path
  // NO restart here: the reply is about to play — speak() freezes the session and
  // _afterSpeak's tail reopens the next window (the step-5 reply-flow resume).
}

function csCloseSession(reason) {
  const was = csActive;
  csActive = false; csSpeaking = false; csHadExchange = false; csOffered = false; offerAnswerPending = false; csCloseAfterDeliver = false;
  csWinSeq++;                                    // orphan any in-flight window callbacks
  clearTimeout(csWindowTimer); clearTimeout(csSilenceTimer); clearTimeout(csOfferTimer); clearTimeout(csResumeTimer);
  try { if (csVad) csVad.stop(); } catch (e) {} csVad = null;
  try { if (csRec && csRec.state !== 'inactive') { csRec.onstop = null; csRec.stop(); } } catch (e) {}
  csRec = null; csChunks = [];
  try { if (csStream) csStream.getTracks().forEach(t => t.stop()); } catch (e) {} csStream = null;
  try { if (csCtx) csCtx.close(); } catch (e) {} csCtx = null;
  setMicState('off');
  // CLOSE-ORDER: same rule as the convo engine — a speaking close is words FIRST,
  // falling cue LAST (fired by _afterSpeak); wordless closes (tap etc.) cue now.
  const csSignOff = was && (reason === 'phrase' || reason === 'silence' || reason === 'offer-no' || reason === 'x-escape');
  if (was && !csSignOff) convoCloseCue();   // the same falling cue, once per session (convoCued guard)
  logEvent('cs.close', reason + (was ? '' : ' (noop)'));
  if (csSignOff) {
    // A session ends with a short sign-off, never silently (settled design) — the SAME
    // reasons and line as the convo session. Tap stays line-less (a deliberate close);
    // swap/honest speak their own honest lines. The sign-off is a close ACKNOWLEDGMENT,
    // so it bypasses the shut-up drop-guard exactly once.
    const m = 'Tap to talk.';
    _allowSignOff = true;
    addMsg('nav', m); lastSpoken = m;
    if (synth) { _closeCueAfterSpeak = true; speak(m); }
    else { speak(m); convoCloseCue(); }
  }
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
  heardSpeech = false; restartBurst = 0; basicProgressAt = Date.now();
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

  recognition.onstart = () => { isListening = true; logEvent('rec.onstart', 'basic'); setMicState('recording'); convoOpenCue(); };   // basic ears open — a tap SENDS; RISING cue (openCued caps it at once even though basic restarts continuously)

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
    const _prevLen = committedFinal.length;
    committedFinal = mergeFinal(committedFinal, instanceFinal);
    if (committedFinal.length > _prevLen) basicProgressAt = Date.now();   // real NEW words captured = progress
    instanceFinal = ''; interimText = '';
    if (!captureActive) return;        // a deliberate stop — stopCapture sends
    // Android ended us early but the driver isn't finished: start another — UNLESS this
    // is a restart churn. Two churn signals close it honestly: many rapid restarts before
    // any speech (a startup failure), OR — once speech HAS been heard — restarts continuing
    // for BASIC_CHURN_MS with no NEW captured words. The second is the field beep loop:
    // heardSpeech latches true, so the old '!heardSpeech' cap could NEVER fire and the ~5s
    // restart churn ran unbounded. Time-since-progress is heardSpeech-independent, so both
    // engines now bound their restart churn within ~15s.
    restartBurst++;
    if ((restartBurst > 12 && !heardSpeech) ||
        (heardSpeech && Date.now() - basicProgressAt > BASIC_CHURN_MS)) {
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
function deliverTranscript(text, source, endReason, tag) {
  // Cloud transcription punctuates; the phone's recogniser doesn't. Normalise
  // once HERE so "Cardwell." and "Cardwell" are the same word everywhere after.
  text = cleanTranscript(text);
  if (text.length <= 1 || _isBusy()) return;
  // SPOKEN cancel: a transcript ENDING with "cancel/scratch/forget that" is binned — no reply, no
  // routing. A session returns to a fresh listening turn (one open cue); a one-shot closes the mic.
  if (isCancelPhrase(text)) {
    logEvent('cancel', 'spoken');
    showCaptured('');
    // CLOUD session (flag-gated): the utterance is already binned by returning here — it
    // never reaches _onTranscript. Blip (per the CS-CANCEL spec; convo's spoken cancel
    // stays blip-less as shipped), then a fresh turn window with its cue. The 45s close
    // is NOT re-armed — the utterance's own voiced ticks just reset it moments ago.
    if (csActive) { cancelBlip(); openCued = false; if (!csSpeaking) csStartWindow(); }
    else if (convoActive) { openCued = false; convoReplyPending = false; convoSetState('listening'); convoOpenCue(); convoArmSilence(); }
    else setMicState('off');
    return;
  }
  // OFFER-NO (field GHR8TSM): the first delivered turn after "Anything else?" answers the
  // offer. A plain negative ENDS the session — sign-off, one close cue, its own reason —
  // instead of routing to the model and re-offering forever. Anything else (a positive or
  // a substantive ask) consumes the context and continues as the ordinary turn it is.
  // (A cancel above returns first, so a binned answer keeps the offer context alive.)
  if (offerAnswerPending) {
    offerAnswerPending = false;
    if (isOfferNo(text)) {
      logEvent('offer', 'no');
      showCaptured('');
      closeConversation('offer-no');   // routes to whichever engine holds the session
      return;
    }
  }
  // CS-CLOSE-WORDS (field 2WYPVSZ): a close phrase ends the session at ANY point — both
  // engines share this seam (the cloud engine had NO engine-side close check at all, so
  // "close" and "end chat" were answered by the model). Full-match only; the sign-off and
  // the single close cue come from the close paths. No session open → ordinary delivery.
  if ((convoActive || csActive) && isClosePhrase(text)) {
    showCaptured('');
    closeConversation('phrase');
    return;
  }
  // How the turn ended ('silence' natural · 'cutoff' force-ended · 'tap' driver
  // chose to send). sendMessage consumes it once to guard destination resolution
  // against fragments left by a hard cutoff. Not a second route — just metadata.
  pendingTurnEnd = endReason || 'silence';
  lastSessionCancelAt = 0;   // a DELIVERED turn resets the ✕-escape pattern
  selfOpenArmed = true;      // a driver WORD re-arms the self-opener (STAYS-SHUT-2)
  // DIAGNOSTIC (console only now): WHICH ears heard it — ☁️ cloud/Whisper vs
  // 📱 basic/Web Speech. The status element shows only the five mic states, so the
  // source tag no longer rides the status line (it stays in the console log).
  console.info('[ears] transcript via ' + (source === 'basic' ? 'BASIC (Web Speech)' : 'CLOUD (Whisper)') + ': ' + JSON.stringify(text));
  showCaptured(text);
  setMicState('thinking');   // heard — now processing
  logEvent('deliver', source + ':' + endReason + (tag ? ' ' + tag : ''));   // the cs window id rides the LOG only — never the turn metadata
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
// CLOSE-ORDER: a speaking close's falling cue waits for the sign-off to finish —
// the goodbye tone is the LAST sound. Cleared by cancelSpeech (a driver kill
// silences everything, cue included — STAYS-SHUT).
let _closeCueAfterSpeak = false;
// CLOSE-ORDER clip protection: SHORT standalone utterances start this much late so a
// cold speaker route (Bluetooth/cab audio waking up) can't eat the first word.
const TTS_LEAD_PAD_MS = 250;
let _ttsPadTimer = null;   // the pending padded start — cleared by any newer speak/cancel
function queueReplies(on) { _queueReplies = !!on; }

function speak(text) {
  if (!synth) return;
  // STAYS-SHUT-2: after a shut-up, with no session open, a late reply is DROPPED entirely
  // — not spoken, not queued. The close's own sign-off carries a one-shot allowance.
  const allow = _allowSignOff; _allowSignOff = false;
  if (!selfOpenArmed && !convoActive && !csActive && !allow) { logEvent('tts.drop', ''); return; }
  // App-sequential reply while something is already playing → wait our turn.
  if (_queueReplies && _ttsActive) { _ttsQueue.push(text); return; }
  if (csActive) {
    // CLOUD session: never hear — or worse, UPLOAD — our own reply. The open turn
    // window is DISCARDED outright (binned locally), and the session silence clocks
    // freeze while we speak (the same V9ZUTAZ discipline as the convo branch below).
    // _afterSpeak's tail reopens a fresh window when it's genuinely the driver's turn.
    csSpeaking = true;
    clearTimeout(csResumeTimer);
    csDiscardWindow(csRec ? 'tts' : '');
    clearTimeout(csSilenceTimer); clearTimeout(csOfferTimer);
  }
  if (convoActive) {
    convoSpeaking = true; convoStopRecogniser();   // don't hear our own reply
    // Pause the SESSION silence clock (hard-close AND the offer nudge) while WE speak.
    // Both were armed on the driver's last speech; left running they keep counting
    // through our own TTS, so a reply longer than the window fires 'close silence'
    // mid-speech (field id V9ZUTAZ: close fired 27s into a reply, tts.end 0.04s later).
    // Re-armed FRESH after tts.end + the reopen tail (see _afterSpeak) — the driver's
    // silence clock starts when it's actually their turn to speak.
    clearTimeout(convoSilenceTimer); clearTimeout(convoOfferTimer);
  }
  synth.cancel();
  _ttsQueue = [];            // a normal/interrupting speak supersedes anything pending
  _speakNow(text);
}

function _speakNow(text) {
  _ttsActive = true;
  parkedAnswer = null;   // a NEW utterance supersedes any parked one (CARRY-ON release rule)
  let clean=text.replace(/\*\*(.*?)\*\*/g,'$1').replace(/\*(.*?)\*/g,'$1').trim();
  // TTS PUNCTUATION HYGIENE (SIGN-OFF ticket): em/en dashes make engines stumble in
  // playback (field 8 Aug: the sign-off hiccuped at its dash). At THIS seam only —
  // every spoken reply funnels through here — they become a comma-pause. Screen text
  // is untouched (addMsg renders the original); plain hyphens ("check-in") are kept.
  clean = clean.replace(/\s*[—–]\s*/g, ', ');
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
  _currentUttText = clean; _speakStartedAt = Date.now(); _boundariesSeen = false; _spokenCharIndex = 0;   // CARRY-ON position tracking
  utt.onboundary = (e) => { if (e && typeof e.charIndex === 'number') { _spokenCharIndex = e.charIndex; _boundariesSeen = true; } };
  utt.onstart = () => { logEvent('tts.start', ''); setMicState('speaking'); };
  utt.onerror = _afterSpeak;
  utt.onend = _afterSpeak;
  // CLOSE-ORDER clip pad: short standalone utterances (the sign-off family) on a COLD
  // route start TTS_LEAD_PAD_MS late; ordinary replies (long, or a warm route mid-flow)
  // start immediately. The pending start dies with any newer speak/cancel.
  clearTimeout(_ttsPadTimer);
  if (clean.length <= 40 && !synth.speaking) {
    _ttsPadTimer = setTimeout(() => synth.speak(utt), TTS_LEAD_PAD_MS);
  } else {
    synth.speak(utt);
  }
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
    _ttsNextTimer = setTimeout(() => { if (convoActive) { convoSpeaking = true; convoStopRecogniser(); } if (csActive) csSpeaking = true; _speakNow(_ttsQueue.shift()); }, CONVO_TTS_TAIL_MS);
    return;
  }
  // CLOSE-ORDER: the sign-off just finished — NOW the falling cue, the session's last sound.
  if (_closeCueAfterSpeak) { _closeCueAfterSpeak = false; convoCloseCue(); }
  if (csActive) {
    // CLOUD session reply finished: stay shut for the tail (speaker decay + room echo),
    // THEN it's genuinely the driver's turn — fresh window (rising cue via the step-4
    // guards) and the silence clocks re-armed from zero. This is the reply-flow resume
    // that lifts the skeleton's one-turn limit.
    csHadExchange = true;
    clearTimeout(csResumeTimer);
    if (csCloseAfterDeliver) {
      // TAP-SEMANTICS: the driver tapped during thinking; the answer has now been given.
      // Close as promised — after the tail so the last word breathes. 'tap-deferred'
      // bypasses the shut-up (nothing here is a late reply — it was the point).
      csCloseAfterDeliver = false;
      csResumeTimer = setTimeout(() => { csSpeaking = false; csCloseSession('tap-deferred'); }, CONVO_TTS_TAIL_MS);
      return;
    }
    csResumeTimer = setTimeout(() => {
      csSpeaking = false;
      if (csActive) { csStartWindow(); csArmSilence(); }
    }, CONVO_TTS_TAIL_MS);
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
    // The reply for the previous turn has finished (tts.end + tail) — NOW it's genuinely the
    // driver's turn. Clear reply-pending and reset the ceiling to 0 BEFORE reopening, so the
    // driver gets the FULL fresh grace (the compose/TTS cycles were suspended, never counted)
    // and the resume reopen counts as the first idle driver-turn cycle, exactly as the ceiling
    // was designed. convoStartRecogniser may close the session (reopen ceiling) — re-check.
    if (convoActive) { convoReplyPending = false; convoUndelivered = 0; convoSetState('listening'); convoStartRecogniser(); if (convoActive) { convoArmSilence(); convoOpenCue(); } }   // reply done (tts.end + tail) → driver's turn again → RISING cue (once)
  }, CONVO_TTS_TAIL_MS);
}

  // ── voices warm-up (was the index.html INIT line) ──────────────────────────
  if (synth) synth.onvoiceschanged = () => synth.getVoices();

  // ── PUBLIC API — the ONLY surface index.html may touch ─────────────────────
  function cancelSpeech() { _ttsQueue = []; _queueReplies = false; _ttsActive = false; _closeCueAfterSpeak = false; clearTimeout(_ttsNextTimer); clearTimeout(_ttsPadTimer); try { synth && synth.cancel(); } catch (e) {} }
  // Full voice shutdown for "start again" (was three lines in resetConversation:
  // cancel TTS, stop the basic recogniser if listening, close any live session).
  function voiceReset() {
    cancelSpeech();
    try { if (recognition && isListening) recognition.stop(); } catch (e) {}
    if (convoActive) closeConversation('reset');
  }
  // One-shot end-reason for the NEXT app send (was: read+null pendingTurnEnd).
  function takeTurnEnd() { const t = pendingTurnEnd; pendingTurnEnd = null; return t; }
  // STAYS-SHUT-2: the ONLY entry a self-opener may use. Refused while stood down (a
  // shut-up happened and the driver hasn't acted since), while ANY audio is playing,
  // or while a session already holds the mic. Driver taps keep using openSession.
  function requestSession() {
    if (!selfOpenArmed || _ttsActive || convoActive || csActive) return false;
    openConversation();
    return true;
  }

  return {
    BUILD: '08 Aug 2026, 01:23 PM AEST',
    // sessions + capture
    openSession:  openConversation,
    requestSession: requestSession,   // gated SELF-open (the after-call reopen) — never overrides a shut-up
    closeSession: closeConversation,
    toggleCapture: toggleVoice,
    cancelCapture: cancelCapture,   // bin the in-progress capture (the red ✕ / a spoken "scratch that")
    micTap:       micTap,
    reset:        voiceReset,
    // speech out
    speak:        speak,
    resumeSpeech: resumeSpeech,   // CARRY-ON: continue-words re-speak a freshly-cut answer (true = handled)
    queueReplies: queueReplies,   // app-sequential replies queue (don't self-interrupt)
    cancelSpeech: cancelSpeech,
    unlockAudio:  unlockAudio,
    // state (read-only getters — no external writes to internals)
    state:         function () { return micState; },
    isSessionOpen: function () { return convoActive || csActive; },   // whichever engine holds the session
    isCapturing:   function () { return cloudActive || captureActive; },
    canHandsFree:  convoSupported,   // does this browser support a hands-free session? (gates the first-use tip)
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
