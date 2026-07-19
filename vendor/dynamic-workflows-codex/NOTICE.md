# Third-party vendored code

The files in `src/` are copied **verbatim** from an external MIT-licensed project.
They are not original to codex-fleet.

- **Upstream project:** claude-dynamic-workflows-codex
- **Upstream URL:** https://github.com/scasella/claude-dynamic-workflows-codex
- **Author / copyright holder:** Stephen Casella
- **License:** MIT (see `LICENSE` in this directory — copied verbatim from upstream)
- **Vendored from upstream commit:** `16524bea870a51ac7bfb3dc7dce77e333c7a56e1`
- **Vendored on:** 2026-07-19
- **Files retained:** 7 modules from upstream's `runner/src/*.js` set, unmodified:
  `appServerClient.js`, `codexSession.js`, `codexAgent.js`, `agentTypes.js`,
  `meter.js`, `modelMap.js`, `worktree.js`.
- **Files removed:** on 2026-07-19 the 9 modules unreachable from the two entry
  points codex-fleet imports (`appServerClient.js` and `codexSession.js`) were
  deleted from this vendored copy: `asciiMap.js`, `codexVersion.js`,
  `compareRuns.js`, `fleetStatus.js`, `journal.js`, `runModel.js`,
  `runSummary.js`, `runWorkflow.js`, `runtime.js`. (Originally the entire
  16-file `runner/src/*.js` module set was copied.)

## Why this is here

codex-fleet's v0.2 app-server backend wired only upstream's
`appServerClient.js` (the JSON-RPC transport for `codex app-server`). Although
`codexSession.js` was included in the vendored module set, v0.2 did not import
or use it. As of v0.3, codex-fleet adopts the vendored `codexSession.js` as its
sessionful thread/turn worker. The retained modules are exactly the static
import closure of those two entry points (including the dynamic
`import("./worktree.js")` calls), so the vendored module graph resolves
without edits.

## Compliance

Per the MIT License, the copyright notice and permission notice
(`LICENSE` in this directory) are retained with the copied code. codex-fleet
does not claim authorship of these files. Any modifications made downstream of
the vendored commit are recorded in this file below.

## Local modifications

- **2026-07-19 — vendor trim (deletions only):** removed the 9 modules listed
  above that are unreachable from the entry points codex-fleet imports. No
  retained file was edited — all 7 remaining `src/*.js` files are byte-for-byte
  as of the vendored commit. If any file here is later edited, note the file
  and the change in this section.
