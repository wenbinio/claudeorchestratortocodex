# Cloud-surface validation checklist

One-time scripted run (~15 min) in a real claude.ai/code cloud session, on a repo that has the fleet-enable block checked in. This validates the "cloud sandbox surface" entries on the README untested-at-release list and spec claim A7.11 (hooks fire in cloud with `CLAUDE_CODE_REMOTE=true`).

**Prereqs (before opening the cloud session):**

- Target repo has this exact block committed in `.claude/settings.json` (see README "Cloud sandboxes"):
  ```json
  {
    "enabledPlugins": { "codex-fleet@wenbinio": true },
    "extraKnownMarketplaces": {
      "wenbinio": {
        "source": { "source": "github", "repo": "wenbinio/claudeorchestratortocodex" }
      }
    }
  }
  ```
- `OPENAI_API_KEY` added as an environment secret for the repo's cloud sessions.

Run the steps in order; fill the Results table as you go. Cloud sandboxes are Linux, so the POSIX guard path (`scripts/merge-guard.sh`) is what fires.

## 1. Plugin loads from checked-in settings

1. Open a claude.ai/code cloud session on the target repo.
2. Type `/codex-fleet:setup`. If the command is unknown / the skill does not load, the plugin did not install from `enabledPlugins` + `extraKnownMarketplaces` — record FAIL with the exact error text.
3. Record PASS if the setup skill begins executing.

## 2. Setup completes headless

While `/codex-fleet:setup` runs (or run these directly if setup stalls), capture:

1. Node present: `node --version` — need >= 18. Record version.
2. Codex installable: `which codex || npm i -g @openai/codex && which codex`. Record whether the global npm install succeeds in the sandbox and the resulting path.
3. Auth smoke (API-key mode):
   ```sh
   codex exec --sandbox read-only --ephemeral 'Reply with exactly: READY' < /dev/null
   ```
   Record PASS only on exit 0 with final answer `READY`. (Stdin must be redirected from `/dev/null` — without it `codex exec` hangs.)
4. Read back the written config: `cat "${CLAUDE_PLUGIN_DATA:-$HOME/.claude/plugins/data/codex-fleet}/config.json"`. Record `authMode` and `backend` (expected: `api_key`, and `app-server` if the runner probe passes, else `exec`).

## 3. Data-dir persistence across session restart

1. Record the resolved data dir: `echo "$CLAUDE_PLUGIN_DATA"`; if empty, `ls -d ~/.claude/plugins/data/*codex-fleet*`.
2. Confirm `config.json` exists there: `ls -l "<dataDir>/config.json"`.
3. Write a sentinel: `date -u +%FT%TZ > "<dataDir>/persist-probe.txt"`.
4. End the session. Start a NEW cloud session on the same repo.
5. In the new session: `cat "<dataDir>/persist-probe.txt"` (re-resolve the dir as in step 1 — the path itself may change).
6. Record: exact path, and persistence yes/no. If no, confirm the README caveat ("re-run setup per session") by running `/codex-fleet:setup` again and noting it completes.

## 4. Tiny run end-to-end

1. Pick a trivial, verifiable change in the repo (e.g. fix a typo in a comment).
2. Run `/codex-fleet:solo <the trivial task>` (or `/codex-fleet:delegate` if you want the interactive surface instead — one of the two is sufficient).
3. Record: did the worker start, produce a diff, pass verification, and integrate? Paste the final run summary line. If it fell back to Claude-only mode, record why (from setup's `authMode`).

## 5. Merge guard fires in cloud (spec claim A7.11)

Seed a guaranteed-block state, then have Claude attempt the merge through its shell tool:

1. Record the platform signal: `echo "$CLAUDE_CODE_REMOTE"` (A7.11 says `true` in cloud).
2. Guard dependency check: `command -v jq` — the sh guard exits open without jq; if absent, record that (it is itself a finding: guard is inert in cloud until jq is present).
3. Create a throwaway branch: `git branch codex/guardtest`.
4. Seed a stale verdict into the store (recorded SHA is well-formed but will not match the branch tip → block-on-stale path):
   ```sh
   REPO_KEY=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)
   DATA_DIR=${CLAUDE_PLUGIN_DATA:-$(ls -d ~/.claude/plugins/data/*codex-fleet* | head -1)}
   jq -n --arg repo "$REPO_KEY" \
     '{($repo): {"codex/guardtest": {"sha": "0000000000000000000000000000000000000000", "verdict": "approve"}}}' \
     > "$DATA_DIR/approved.json"
   ```
5. Ask Claude (in the session, as a normal prompt): "Run `git merge codex/guardtest`." The PreToolUse hook must fire and the command must be BLOCKED with the "Merge blocked for branch 'codex/guardtest' (verdict: stale...)" message.
6. Record: blocked yes/no, the exact block message, and the `CLAUDE_CODE_REMOTE` value from step 1.
7. Clean up: `rm "$DATA_DIR/approved.json" && git branch -D codex/guardtest`.

## 6. Failure notes

For every red row above, record ALL of:

- Step + sub-step number
- Exact command run
- Exact error output (verbatim, first + last 5 lines if long)
- Environment facts: `node --version`, `codex --version` (if installed), `echo $CLAUDE_CODE_REMOTE`, `echo $CLAUDE_PLUGIN_DATA`, `command -v jq`
- Whether a retry in the same session reproduced it

## Results

| # | Check | Result (PASS/FAIL/SKIP) | Evidence / notes |
|---|-------|------------------------|------------------|
| 1 | Plugin loads from checked-in settings.json | | |
| 2a | `node --version` >= 18 | | version: |
| 2b | Codex installable via npm | | path: |
| 2c | READY auth smoke with OPENAI_API_KEY | | |
| 2d | config.json written (authMode / backend) | | values: |
| 3 | Data dir persists across restart | | path: · persists: yes/no |
| 4 | Tiny solo/delegate run end-to-end | | summary line: |
| 5a | `CLAUDE_CODE_REMOTE` value | | value: |
| 5b | jq present in sandbox | | |
| 5c | Guard blocks stale `codex/guardtest` merge | | block message: |

## Recording results

Paste the filled Results table (plus any Failure notes) back into this file under a `## Run log — <date>` heading, and land it via PR or direct commit to `wenbinio/claudeorchestratortocodex`.

Once all rows are green, update:

- **README.md** — "Cloud sandboxes" section: drop the "cloud guard behavior is on the untested-at-release list" hedge (currently line ~112) and resolve the data-dir "may require rerunning `setup` per session" caveat per row 3's outcome; "Limitations & release status": remove "the cloud sandbox surface (including cloud merge-guard behavior)" from the untested-at-release bullet (currently line ~122).
- **docs/specs/2026-07-18-codex-fleet-plugin-design.md** (owned by spec agent — file an update, do not edit blind): A6 cloud note on data-dir persistence (currently line ~206) and the A6 "Honest untested-at-release list" (line ~207); A7.11's "cloud guard behavior joins the honest untested-at-release list (unverifiable from this machine)" clause (line ~221).
