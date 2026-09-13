# Phase 5: WhatsApp

The existing Baileys fitting registers a Messages descriptor, retains its established pairing and 60-second agent outbox, adds a durable 24-hour reconciliation journal, and exposes bounded read, media and action callbacks. User sends go immediately through the existing send path. After Messages registration, inbound bodies feed the store without automatic model dispatch.

Two unique browser cases passed for the group-photo reply journey. Both profiles are covered: iPhone 390 by 844, device scale factor 3 and touch, and desktop 1440 by 900. They prove discovery through the fitting descriptor, the WhatsApp badge and group title, fitted and zoomed full-screen photos, and a user reply. The phase fixture batch recorded 19 passing WhatsApp tests.

The lead viewed all eight final screenshots in `evidence/messages/p5`. The stems `group-inbox`, `photo-viewer`, `photo-viewer-zoomed` and `group-replied` each have an `-iphone.png` and `-desktop.png` capture. The zoomed capture intentionally shows a magnified image; the separate fitted capture proves the initial complete image view. The complete filename inventory is [ui-screenshot-inventory.json](../../evidence/messages/p8/ui-screenshot-inventory.json), and the final browser receipts are [ui-test-results.json](../../evidence/messages/p8/ui-test-results.json).

Live acceptance remains open until the committed implementation is deployed to Madrid and the paired self-only image, read and reply smoke passes. Browser fixtures do not close that gate. The Phase 5 acceptance sentinel has not been printed.
