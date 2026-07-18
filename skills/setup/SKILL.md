---
name: setup
description: Use when the user asks to configure, bootstrap, repair, or re-verify codex-fleet on a machine or cloud session, or when its config.json is missing or stale.
---

# Set Up Codex Fleet

Discover the local Codex CLI, verify non-interactive authentication, and write machine-local plugin configuration. Do not write machine facts into the plugin repository.

## Resolve the platform and data directory

1. Detect `windows` versus `posix` and use exactly that lowercase value for `platform`.
2. Resolve the data directory to `${CLAUDE_PLUGIN_DATA}` when it is available; otherwise use `~/.claude/plugins/data/codex-fleet/`.
3. Create that data directory if needed. The target is `<dataDir>/config.json`.

## Discover Codex

On Windows, parse `CODEX_CLI_PATH` from `~/.codex/config.toml`, resolve it to an absolute path, and verify that the file exists. The executable path is hash-versioned and changes on application updates, so never hard-code or reuse an unverified old path. If the key or file is missing, tell the user to install or refresh the Codex desktop application and re-run setup.

On POSIX, run `which codex`. If it is absent, guide the user through `npm i -g @openai/codex`, running the global install only with their confirmation, and then run `which codex` again.

Set `codexExe` to the discovered absolute executable path. If no executable is available or the user declines installation, set `codexExe` to `null`, classify authentication as `none`, and still write the config so dispatch can use its Claude-only fallback.

## Run the headless READY smoke

When `codexExe` is available, run an ephemeral, read-only smoke and require a successful exit plus the final answer `READY`. Standard input must be closed; without this, `codex exec` can hang forever while waiting for more input.

Windows PowerShell:

```powershell
$null | & $codexExe exec --sandbox read-only --ephemeral 'Reply with exactly: READY'
```

POSIX shell:

```sh
"$codexExe" exec --sandbox read-only --ephemeral 'Reply with exactly: READY' < /dev/null
```

Classify `authMode` from the successful smoke:

- `api_key` when `OPENAI_API_KEY` is present and the smoke works with it.
- `subscription` when the smoke works through the existing Codex/ChatGPT login without an API key.
- `none` when Codex is unavailable, the smoke fails, or no non-interactive authentication works.

Do not start an interactive OAuth flow in a headless or cloud session.

## Probe the runner backend (v0.3)

Resolve Node to an absolute `nodeExe` and run `<nodeExe> --version`. Node is usable only when the executable exists and its major version is >= 18. When `mode` will be `codex` (`authMode` is `subscription` or `api_key`) and both absolute `codexExe` and usable absolute `nodeExe` are present, run this capability probe with the absolute paths:

```text
"<absolute nodeExe>" "<absolute plugin root>/runner/fleet-runner.mjs" --probe
```

The probe must initialize `codex app-server`, list its models, and complete one ephemeral read-only turn. Record `backend` as `app-server` only when all three steps succeed and the runner reports compatibility. If the probe fails or reports incompatibility, record `backend` as `exec`; keep `nodeExe` set to its absolute path so the runner can use its `exec` transport. Re-run the probe whenever the Codex or Node version changes. If Node is missing or older than 18, record `backend` as `exec` and `nodeExe` as `null`; dispatch then uses the no-Node Agent-tool fallback (or the Claude-only fallback when `authMode` is `none`).

## Write configuration

Write `<dataDir>/config.json` with exactly these eight keys and no credentials:

```json
{
  "codexExe": "<absolute executable path>",
  "platform": "windows",
  "authMode": "subscription",
  "model": "gpt-5.6-sol",
  "effort": "xhigh",
  "backend": "app-server",
  "nodeExe": "<absolute node path, or null>",
  "verifiedAt": "<ISO-8601 UTC timestamp>"
}
```

Use the actual `platform` and `authMode`; encode `codexExe` as JSON `null` when unavailable. `model` and `effort` default to `gpt-5.6-sol` / `xhigh`; honor explicit values from the machine's `~/.codex/config.toml` when present so fleet workers match the user's chosen model. Set `backend` from the capability probe above, never from Node presence alone, and set `nodeExe` to the absolute usable path or JSON `null`. Set `verifiedAt` to the time this setup attempt completed. Report the config path, discovered executable, platform, authentication classification, and selected backend without exposing any secret.

If `authMode` is `none`, explain that `/codex-fleet:dispatch` will run the same worktree, verification, review, and integration pipeline in Claude-only mode. The plugin data directory's persistence in cloud sandboxes is unverified, so setup may need to be run again in each cloud session.
