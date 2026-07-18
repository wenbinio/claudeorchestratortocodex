# Third-party vendored code

The files in `src/` are copied **verbatim** from an external MIT-licensed project.
They are not original to codex-fleet.

- **Upstream project:** claude-dynamic-workflows-codex
- **Upstream URL:** https://github.com/scasella/claude-dynamic-workflows-codex
- **Author / copyright holder:** Stephen Casella
- **License:** MIT (see `LICENSE` in this directory — copied verbatim from upstream)
- **Vendored from upstream commit:** `16524bea870a51ac7bfb3dc7dce77e333c7a56e1`
- **Vendored on:** 2026-07-19
- **Files copied:** the entire `runner/src/*.js` module set (16 files), unmodified.

## Why this is here

codex-fleet's v0.2 app-server backend uses upstream's `appServerClient.js`
(JSON-RPC transport for `codex app-server`) and `codexSession.js` (sessionful
thread/turn worker) rather than reimplementing them. The remaining modules are
kept intact so the vendored module graph resolves without edits.

## Compliance

Per the MIT License, the copyright notice and permission notice
(`LICENSE` in this directory) are retained with the copied code. codex-fleet
does not claim authorship of these files. Any modifications made downstream of
the vendored commit are recorded in this file below.

## Local modifications

None. Files are byte-for-byte as of the vendored commit. If any file here is
later edited, note the file and the change in this section.
