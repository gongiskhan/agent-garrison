# Voice conversation controls

The phone and pendant use the existing Capture ingress, Deepgram transcript, wake bus and standing Zeca conversation. Commands go directly to that conversation without the spoken repeat-back. Wake aggregation and card creation remain unchanged.

## Interruption and feedback

Native sessions advertise `speech_protocol: 1`. While a reply is pending on that session, the server rejects its own echo before considering interruption. Recognizable final speech requires confidence of at least 0.85 and 350 ms of speech; a single word requires 0.92 and 180 ms. Interim speech needs at least two words, confidence 0.9, 450 ms of speech, and stable text across two observations at least 250 ms apart. Empty input, noise markers and uncertain recognition do not interrupt. Confidence measures recognition accuracy, not identity. There is no enrolled voiceprint, so another person speaking clearly nearby can still interrupt.

The existing socket sends `speech.interrupt` with the pending acknowledgement IDs for that stream. The native SpeechSink stops the current clip or synthesizer, cancels queued clips, and sends a `user-speech` receipt. Generation checks keep late downloads and callbacks from restarting speech. Older apps do not advertise support and retain their existing behavior.

Every conversation reply registers a feedback window before playback is sent. Its successful completion receipt opens the window for exactly 15 seconds; interruption opens it immediately so the interrupting sentence becomes feedback. The existing conversation ID remains bound. Only confident final text is dispatched, after a 900 ms settling interval. Continued interim speech extends settling without dispatching provisional words. Speech begun inside the window can finish after expiry, with a 30-second utterance ceiling. Noise or silence produces no turn. After the window closes, a wake word is required again.

## Voice quality

On 12 September 2026 the active phone node selected ElevenLabs with no active fallback. The account subscription was active with 43,697 characters remaining. Its counters also recorded a long reply falling back to the system voice: provider rendering previously refused anything over 600 characters. This check rules out an exhausted account at that time, not every historical provider failure.

Long replies now use ordered clips of at most 600 characters, with at most two concurrent renders per reply through the existing cached provider path. The phone plays the clips sequentially and reports completion after the final clip. Only a failed clip falls back to the system voice. Provider keys remain server-side. Relative clip URLs resolve against the phone's selected Capture node.

## Verification

Server regression coverage includes real authenticated WebSocket ingress for both sources, noise and echo rejection, interruption, same-conversation feedback, no repeat-back or interruption push, long-clip boundaries, and exact timeout behavior. Native tests cover ordered playback, cancellation during clips and synthesis, late callback rejection and wire decoding. The existing simulator validation workflow also exercises interruption through CaptureController and its real native upload socket against an isolated local node.

Physical checks after installing the new TestFlight build: ask for a long answer, interrupt with a clear sentence, and confirm the old answer stays stopped; try nearby handling noise and confirm playback continues; speak feedback within 15 seconds of completion without saying Zeca; wait longer and confirm a wake word is needed. Audible voice quality and real acoustic separation require a device and are not claimed from synthetic transcripts.
