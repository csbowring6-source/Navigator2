# Conversation Mode — Investigation

*26 Jul 2026 · code reading + git history. No code changed. Where the field failure mode can't be pinned from code alone, that's said plainly — it needs on-device console logging to confirm.*

## What's wired
- **API:** the Web Speech API (`webkitSpeechRecognition`, `continuous = true`) as the base recogniser, now fronted by "cloud ears" (MediaRecorder → Worker `/transcribe`) as the primary capture. Conversation mode adds no new capture code — it just re-invokes the normal listen entry point.
- **Toggle:** the button `#wakeBtn` (`🎙 Conversation: Off`) → `toggleWakeWord()` → `setConvo(bool)`, which flips `convoEnabled`, updates the label, and (on) calls `unlockAudio()`.
- **Intended flow:** toggle on → after every Navigator TTS reply, `speak()`'s `utt.onend` runs `setTimeout(startListening, 600)` to re-open the mic hands-free → driver replies → repeat. Two silent 9 s turns (`noSpeechTimer`), or saying "close", ends it.

## Did it ever work? (git history)
**No evidence it did.** The only related commit, `5bd7da4 "Mic capture: continuous listening, tap-to-send…"`, is about the *tap*-capture model (`continuous=true` + tap-to-send + Android restart-stitching) — **not** the conversation auto-re-open. No commit ever added or validated the re-open loop. Consistent with "never worked."

## The actual failure
It is a **start-and-stop / never-usefully-continuous** failure by design, not a routing failure — and the design also explains the toggle showing "Off":
1. **It never starts on toggle-on.** The mic only re-opens *after a TTS reply*. Toggling on and speaking does nothing until you first tap, speak, and get a reply.
2. **The re-open window is silent and short.** When it does re-open there's no earcon or clear cue and only a 9 s window; easy to miss entirely.
3. **It disables itself.** Two missed windows → `setConvo(false)`. **That is why the toggle reads "Off"** after use — it self-reverts, so the driver keeps tapping.

Whether, on the Android device, the re-open even fires or a guard (`busy`/`isListening`/`captureActive`) blocks it, I can't prove from code — that needs one on-device run with logging around `onend`/`startListening`. But the three design faults above make it fail in practice regardless.

## Android Chrome vs iOS Safari
- **Android Chrome:** continuous recognition *is* achievable here; the failure is the loop design above (post-reply-only, silent, short, self-disabling), not a platform wall. Fixable.
- **iOS Safari (WebKit):** additionally blocked at the platform level. The re-open is a **timer, not a user gesture**, so the silence-detection `AudioContext` starts *suspended* (no auto-stop — the mic won't stop itself), and WebKit's recogniser restart off-gesture is unreliable (mic not stopping, no result, first-attempt failure — the exact known symptoms). **True hands-free continuous listening is not reliably achievable on iOS WebKit in a web app.** Say so rather than chase it.

## Shared handler?
**Shared.** Both the mic-tap (`toggleVoice → startListening`) and the conversation re-open (`speak().onend → setTimeout(startListening)`) enter the **same** `startListening()`. Not separate code paths — so any listen fix benefits both.

## Standard iOS mitigations — in place?
- **Singleton recognition object:** **No.** `startRecogniser` does `recognition = new SR()` every capture (aborting the prior one). Recreated each time.
- **Kept-warm mic:** **No.** `ensureMicPermission` grabs a stream only to confirm the grant, then `getTracks().forEach(t => t.stop())`. Nothing kept alive between turns.
- **Auto-restart on `onend`:** **Partial.** `recognition.onend` restarts *within* a capture (Android early-end stitching), gated on `captureActive` — not the conversation re-open. The re-open is a separate `speak().onend`.

So none of the three recommended WebKit mitigations are meaningfully present.

## Options (effort · risk)
1. **On-device diagnose first (≈1 hr · low).** Temporary logging on the Android device to confirm fire-vs-blocked. Prerequisite to any fix.
2. **Redesign the loop for Android (≈half-day · low-med).** Start listening on toggle-on; add an audible/visible "your turn" cue; soften the 9 s / 2-turn self-disable. Makes it genuinely continuous where the platform allows.
3. **iOS WebKit mitigations — singleton recogniser + kept-warm mic + restart-on-onend (≈1–2 days · med-high, uncertain payoff).** The textbook fixes, but WebKit continuous stays flaky; likely still not reliable. Only worth it if a device test shows promise.
4. **Accept the limit — gate to Android, honest on iOS (≈1 hr · low).** Conversation mode on Android; on iPhone present tap-to-reply with a one-line "hands-free needs Android or a CarPlay/Bluetooth mic." Matches SPEC §0.

**Recommendation:** (1) diagnose on-device, then (2) redesign for Android + (4) honest iOS gating. Don't invest in (3) unless a real iPhone test shows WebKit continuous can hold.
