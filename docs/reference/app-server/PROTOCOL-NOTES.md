# app-server protocol — observed versions

Captured from the locally installed binary via `codex app-server generate-json-schema`.

| Date | codex-cli version | Note |
|---|---|---|
| 2026-07-19 | 0.145.0-alpha.18 | initial capture; live wire transcript in `live-probe-transcript.jsonl` |
| 2026-07-19 | 0.145.0-alpha.27 | binary path drifted mid-session |
| 2026-07-19 | 0.146.0-alpha.3.1 | drifted again |
| 2026-07-21 | 0.147.0-alpha.6.6 | drifted again; **`turn/steer` confirmed callable** |

**Operational finding:** the hash-versioned binary path drifted FOUR times across two
sessions — hours apart, not months. Any recorded `codexExe` must be treated as a
cache that can go stale at any moment; rediscovery on ENOENT is the primary path,
not an error case.

**`turn/steer`** (present in ClientRequest, so a real callable method):
- params: `{threadId, expectedTurnId, input}` (+ optional `clientUserMessageId`)
- result: `{turnId}`
- `input` uses the same shape as `turn/start`: `[{type: "text", text: "..."}]`

This is the mechanism for true mid-turn steering. The vendored `codexSession.js`
does not implement a `steer()` method, but `appServerClient.js` exposes a generic
`request(method, params)`, so steering is wired in codex-fleet's own code without
modifying any vendored file.
