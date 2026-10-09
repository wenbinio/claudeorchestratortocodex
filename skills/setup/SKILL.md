---
name: setup
description: Use when the user asks to configure, bootstrap, repair, or re-verify codex-fleet on a machine or cloud session, or when its config.json is missing or stale.
---

# Set Up Codex Fleet

Discover the local Codex CLI, verify non-interactive authentication, and write machine-local plugin configuration. Do not write machine facts into the plugin repository.

## Resolve the platform and data directory

1. Detect `windows` versus `posix` and use exactly that lowercase value for `platform`.
2. Resolve `dataDir` exactly as setup and later readers do: use non-empty `${CLAUDE_PLUGIN_DATA}` verbatim; otherwise choose the lexicographically-first `~/.claude/plugins/data/*codex-fleet*/` directory containing `config.json`, then the lexicographically-first match, then `~/.claude/plugins/data/codex-fleet/`.
3. Create that data directory if needed. The target is `<dataDir>/config.json`.

## Discover Codex

On Windows, parse `CODEX_CLI_PATH` from `~/.codex/config.toml`, resolve it to an absolute path, and verify that the file exists. The executable path is hash-versioned and changes on application updates, so never hard-code or reuse an unverified old path. If the key or file is missing, tell the user to install or refresh the Codex desktop application and re-run setup.

On POSIX, run `which codex`. If it is absent, guide the user through `npm i -g @openai/codex`, running the global install only with their confirmation, and then run `which codex` again.

Set `codexExe` to the discovered absolute executable path. If no executable is available or the user declines installation, set `codexExe` to `null`, classify authentication as `none`, and still write the config so dispatch can use its Claude-only fallback.

## Choose worker settings

Read the chosen `model` and `effort` from the machine's `~/.codex/config.toml`, defaulting to `gpt-5.6-sol` / `xhigh`. Pin both on every smoke and worker. Validate optional `isolation` as `plugins-off` (default), `ignore-user-config`, or `none`, and optional `windowsSandbox` as `elevated` or `unelevated`; unknown values are errors. `ignore-user-config` requires an explicit non-empty model. Leave `windowsSandbox` absent unless selected explicitly; never force elevated by default.

## Run the headless shell smoke

When `codexExe` is available, require an ephemeral, read-only worker to **execute a shell command** that prints a fresh token such as `FLEET_SHELL_<random-id>` and then answer with that token. Require exit 0, a JSON command-execution item with exit code 0 and that exact output, and a matching final answer. A text-only READY or token answer is insufficient. Close standard input.

Resolve usable Node >= 18 first. When available, use the runner's smoke, passing the absolute executable paths and chosen model/effort:

```text
"<absolute nodeExe>" "<absolute plugin root>/runner/fleet-runner.mjs" --smoke --codex-exe "<absolute codexExe>" --model "<model>" --effort "<effort>"
```

On Windows it tries `plugins-off` first, then `plugins-off` with `windowsSandbox: "unelevated"`. If needed it tries `ignore-user-config` on exec with the pinned model and no implicit Windows sandbox override. It reports each attempt and the passing settings. **Unelevated is a weaker sandbox.** Record a passing unelevated setting only if the caller explicitly invoked `/codex-fleet:setup --allow-unelevated`; forward `--allow-unelevated` to the smoke. Without that opt-in, an unelevated success is diagnostic only. If only that attempt works, fail setup, explain the weaker sandbox and remedy, and preserve any existing config rather than silently saving it. A failed shell smoke must fail setup even when the worker can talk.

Without Node, run the same attempts manually and inspect the `--json` stream. Default attempt (substitute a fresh token and pinned model/effort):

Windows PowerShell:

```powershell
$null | & $codexExe exec --disable plugins -c mcp_servers.node_repl.enabled=false --json --sandbox read-only --ephemeral -m $model -c 'model_reasoning_effort="xhigh"' 'Run a shell command that prints FLEET_SHELL_<random-id>, then reply with that token. Do not run git.'
```

POSIX shell:

```sh
"$codexExe" exec --disable plugins -c mcp_servers.node_repl.enabled=false --json --sandbox read-only --ephemeral -m "$model" -c 'model_reasoning_effort="xhigh"' 'Run a shell command that prints FLEET_SHELL_<random-id>, then reply with that token. Do not run git.' < /dev/null
```

Use the configured effort in place of the illustrative `xhigh`. For the second Windows attempt append `-c 'windows.sandbox="unelevated"'` before the prompt; it remains diagnostic unless `--allow-unelevated` was explicitly supplied. For the exec-only config-free attempt replace `--disable plugins -c mcp_servers.node_repl.enabled=false` with `--ignore-user-config`, retain the explicit `-m` and effort, and supply a Windows sandbox override only when explicitly selected. The `none` mode omits isolation flags and keeps the user's plugins/MCP config; setup does not select it automatically.

On `setup refresh had errors`, report `failureReason: "sandbox_setup_failed"` and this remedy: use `isolation: "plugins-off"` (or `ignore-user-config` with a model on exec); close the Codex desktop app (it runs `node_repl.exe`), or opt in to `windowsSandbox: "unelevated"`, a weaker sandbox. Do not retry unchanged launches.

Classify `authMode` from a successful shell smoke:

- `api_key` when `OPENAI_API_KEY` is present and the smoke works with it.
- `subscription` when the smoke works through the existing Codex/ChatGPT login without an API key.
- `none` when Codex is unavailable or no non-interactive authentication works. A sandbox/shell failure is a setup failure, not evidence of missing authentication.

Do not start an interactive OAuth flow in a headless or cloud session.

## Probe the runner backend

Resolve Node to an absolute `nodeExe` and run `<nodeExe> --version`. Node is usable only when the executable exists and its major version is >= 18. When `mode` will be `codex` (`authMode` is `subscription` or `api_key`) and both absolute `codexExe` and usable absolute `nodeExe` are present, run this capability probe with the absolute paths:

```text
"<absolute nodeExe>" "<absolute plugin root>/runner/fleet-runner.mjs" --probe --codex-exe "<absolute codexExe>" --model "<model>" --effort "<effort>" --isolation "<passing isolation>"
```

Append `--windows-sandbox "<passing windowsSandbox>"` only when the smoke selected an explicit override. The probe must initialize `codex app-server`, list its models, and complete an ephemeral read-only turn with a successful shell command and matching token output. Record `backend` as `app-server` only on compatibility. App-server cannot ignore user config: that request falls back to `plugins-off` with a result note. If the exec smoke required `ignore-user-config`, retain `backend: "exec"` so subsequent workers use the mode that passed. Otherwise, if the app-server probe fails, retain the working exec smoke's settings and `backend: "exec"`; keep usable `nodeExe`. Re-probe when Codex or Node changes. Without Node >= 18, use `backend: "exec"` and `nodeExe: null` for Agent-tool orchestration.

## Write configuration

After the shell smoke passes, write `<dataDir>/config.json` with these keys and no credentials; omit `windowsSandbox` when no override was selected. `codexVersion` and `nodeVersion` make probe staleness a plain string comparison at dispatch time:

```json
{
  "codexExe": "<absolute executable path>",
  "platform": "windows",
  "authMode": "subscription",
  "model": "gpt-5.6-sol",
  "effort": "xhigh",
  "isolation": "plugins-off",
  "backend": "app-server",
  "nodeExe": "<absolute node path, or null>",
  "codexVersion": "<codexExe --version output>",
  "nodeVersion": "<nodeExe --version output, or null>",
  "verifiedAt": "<ISO-8601 UTC timestamp>"
}
```

Use the actual `platform` and `authMode`; encode `codexExe` as JSON `null` when unavailable. Record the exact passing `isolation`. When explicitly opted in and passed, also record `"windowsSandbox": "unelevated"` and clearly say it is a weaker sandbox. An explicitly selected `elevated` override is also supported. Set `backend` from the probe, never Node presence alone, and `nodeExe` to the usable absolute path or JSON `null`. Set `verifiedAt` when setup completes. Report the config path, executable, platform, auth, backend, isolation, and any Windows override without exposing secrets. Older configs lacking isolation default to `plugins-off`; configs lacking `windowsSandbox` leave the user's setting alone.

On Windows the sandboxed worker runs as a different user, so git in a worktree can fail with `dubious ownership`. The Claude driver runs git; never ask Codex to do so.

If `authMode` is `none`, explain that `/codex-fleet:dispatch` will run the same worktree, verification, review, and integration pipeline in Claude-only mode. The plugin data directory's persistence in cloud sandboxes is unverified, so setup may need to be run again in each cloud session.
