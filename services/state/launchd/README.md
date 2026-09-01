# launchd agents (macOS)

The macOS counterparts of `../systemd/`. Same two jobs: the service itself and
the hourly snapshot.

Install:

    cp services/state/launchd/*.plist ~/Library/LaunchAgents/
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.garrison.state.plist
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.garrison.state-backup.plist

Two things differ from the systemd units, deliberately:

- **No tailnet publish.** `garrison-state.service` runs
  `scripts/tailnet-publish.sh` as `ExecStartPost`. These do not: a single-node
  install has no peers, so the socket stays on loopback and is never published.
  Add it back if the box joins a mesh.
- **Paths are absolute.** launchd does not expand `~`, and the plists carry an
  explicit `PATH` because a launchd agent inherits a minimal one — the same
  gotcha `garrison-state.service` documents for systemd. Adjust the user and
  the node path for your box.
