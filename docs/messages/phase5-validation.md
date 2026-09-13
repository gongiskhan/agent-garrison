# Phase 5: WhatsApp

The existing Baileys fitting registers a Messages descriptor, retains its established pairing and 60-second agent outbox, adds a durable 24-hour reconciliation journal, and exposes bounded read/media/action callbacks. User sends go immediately through the existing send path. After Messages registration, inbound bodies feed the store without automatic model dispatch.

Fixture validation: 19 WhatsApp tests pass. The phone and desktop group-photo reply journeys pass. The lead viewed all eight screenshots in evidence/messages/p5 and recorded their verdicts in evidence/messages/vision-checklist.md.

Live acceptance remains open until the committed implementation is deployed to Madrid and the paired self-only image, read and reply smoke passes. The Phase 5 acceptance sentinel has not been printed.
