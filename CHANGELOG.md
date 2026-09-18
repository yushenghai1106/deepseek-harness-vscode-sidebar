# Changelog

## Unreleased

- Fixes the slash-command menu, which was rendered as always-empty because `commands/list` was never requested.
- Streams long conversations incrementally: unchanged transcript rows keep their identity, so only the row being written re-renders.
- Loads session history in pages of 200 with a "Load earlier messages" affordance instead of transferring the whole transcript.
- Bounds file-change snapshots, persisted change records, and large or binary files no longer occupy memory.
- Sends files created by the agent to the trash on revert instead of deleting them permanently.
- Refreshes the changed-files list while the agent edits the workspace.
- Adds `npm run runtime:sync` to normalize a local runtime bundle into the `bin/dsh` layout the extension expects.
- Skips activation on startup so the extension only loads when the Chat view is opened.

## 0.1.4

- Fixes VSIX version discovery in the release workflow.

## 0.1.3

- Adds native VSIX packages for macOS Apple Silicon, macOS Intel, Windows x64, and Linux x64.
- Updates the bundled runtime layout to `bin/dsh` for every platform.

## 0.1.1

- Adds persistent Fork session recovery and branch markers.
- Adds runtime-backed searchable slash-command menu and command result rendering.
- Adds Goal controls, file review actions, and API-key send protection.
- Bundles the macOS Apple Silicon Harness runtime.
