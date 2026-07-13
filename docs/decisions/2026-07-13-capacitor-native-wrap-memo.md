# Capacitor native-wrap memo (voice PWA → native iOS)

**Date:** 2026-07-13
**Status:** Memo only - explicitly **out of scope** for implementation. No code.
**Context:** D20 voice. S6c made the web-channel an installable PWA with iOS
secure-context wiring. This records whether/how we'd later wrap that PWA in
[Capacitor](https://capacitorjs.com) for a real native iOS app, so the decision
is deliberate rather than defaulted into.

## The question

The web-channel is a mobile-first PWA served from the operative's own port and
reached over Tailscale. Should we, later, ship it as a native iOS app by wrapping
the same web build in Capacitor (a native WebView shell with plugin bridges to
native APIs), rather than leaving it a home-screen PWA?

## What Capacitor would buy

- **Background audio / longer sessions.** iOS Safari (and standalone PWAs) suspend
  timers, audio, and network aggressively when backgrounded or the screen locks. A
  native app can hold a background audio session and keep a voice conversation alive
  across a lock - the single biggest limitation of the PWA path for a hands-free
  voice assistant.
- **Push notifications.** Real APNs push (e.g. "the operative finished / needs you").
  iOS web push exists but only for installed PWAs, is newer, and is more limited.
- **App Store distribution + trust.** A tappable App Store install and a signed app
  identity, instead of "open this https URL, Share, Add to Home Screen." Nicer for
  anyone who isn't the developer.
- **Sturdier native capabilities.** First-class mic/permission handling, haptics,
  status-bar/safe-area control, secure storage, and a stable app lifecycle - without
  fighting Safari quirks per iOS release.
- **Removes the secure-context chore.** A native WebView is a secure context by
  construction, so the `tailscale serve` / TLS dance for `getUserMedia` disappears
  on the phone (the app can point at the loopback/tailnet gateway directly).

## What Capacitor would cost

- **A native build toolchain + Apple tax.** Xcode, CocoaPods, an Apple Developer
  account ($99/yr), code signing, provisioning profiles, and (for the store) App
  Review - with its own content/functionality bar an "agent that runs arbitrary
  code" may not clear cleanly.
- **A second artifact to build, sign, and release.** CI has to produce and notarise
  an `.ipa`; every ship is a native release cadence, not a `dist/` rebuild. This is a
  standing maintenance cost, not a one-time setup.
- **Architecture friction with the local-first model.** Garrison is
  localhost/tailnet-only and single-user; the operative's gateway lives on the user's
  machine. A native app still has to reach that machine - so Tailscale (or similar)
  stays in the picture regardless; Capacitor removes the *secure-context* pain but
  not the *reachability* requirement. The app is a thin client to a machine that must
  be online.
- **Plugin surface + native debugging.** Background audio, push, and mic each pull in
  a Capacitor plugin (community or custom) that we now own across iOS updates. Bugs
  move from "inspect in Safari devtools" to native/WebView debugging.
- **Against the Honesty Test.** Garrison's job is compose · run · observe · quarters;
  a bespoke native app is a real ongoing product surface. It should only exist if the
  PWA genuinely can't do the job, not because native feels more legitimate.

## Recommendation

**Do not wrap in Capacitor now. Stay on the PWA.** For S6c's goal - installable,
mic-capable, usable on the phone over Tailscale - the PWA meets the bar at a fraction
of the cost, and keeps a single web artifact and the local-first posture intact.

**Revisit Capacitor only if a concrete need the PWA structurally cannot meet
appears**, most likely one of:

1. **Background / lock-screen voice** becomes a hard requirement (the PWA suspends
   audio on lock) - this is the strongest single trigger.
2. **Reliable push** to summon the user is needed and iOS web push proves
   insufficient.
3. A **non-developer audience** needs App Store distribution.

If we do cross that line, the low-regret path is incremental: Capacitor loads the
*same* web build unchanged (no rewrite), and we add native plugins only for the one
capability that forced the move (e.g. background audio) - not a wholesale native
port. Nothing in S6c precludes that later; the PWA build is the shared foundation
either way.

**Not doing now (out of scope):** Xcode project, Capacitor config, native plugins,
signing/CI, or any App Store work.
