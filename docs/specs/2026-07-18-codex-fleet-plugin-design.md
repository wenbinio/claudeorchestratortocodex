# codex-fleet Plugin — Design Spec

**Date:** 2026-07-18
**Repo:** https://github.com/wenbinio/claudeorchestratortocodex (public)
**Status:** Approved by user; pre-implementation

## Goal

Package the Codex Fleet harness — Claude orchestrating OpenAI Codex CLI (`gpt-5.6-sol`) workers for parallel coding tasks — as a distributable Claude Code plugin, so it works on the author's second machine, is installable by anyone, and functions in Claude cloud sandboxes.

## Background

The harness exists and is proven on one Windows machine (full lifecycle tested green 2026-07-18: parallel dispatch → per-task verify → adversarial review → sequential merge, 2/2 tasks first-try). Current form: a personal skill (`~/.claude/skills/fleet/SKILL.md`), a Workflow engine script (`Downloads\claude\.claude\workflows\codex-fleet.js`), and machine facts in a project CLAUDE.md. All three are machine-locked (hard-coded Windows paths, hash-versioned `codex.exe` location, PowerShell-only idioms).

## Decisions (user-made, binding)

1. **Approach C — full suite**, chosen over the assistant's B recommendation: portable harness PLUS bundled agent definitions, merge-guard hook, and run telemetry.
2. **Public GitHub repo**: `wenbinio/claudeorchestratortocodex`. Consequence: repo carries only generic code; ALL machine-specific facts live in per-machine generated config, never committed.
3. Sandbox auth default (assistant judgment, user deferred): **API key when present, graceful Claude-only fallback when absent.**

## Architecture

```
claudeorchestratortocodex/
├── .claude-plugin/
│   ├── plugin.json           # name "codex-fleet", version, description (no userConfig — machine config lives solely in the data-dir config.json written by setup)
│   └── marketplace.json      # self-hosting marketplace entry
├── skills/
│   ├── dispatch/SKILL.md     # orchestrator procedure
│   └── setup/SKILL.md        # once-per-machine bootstrap
├── agents/
│   ├── codex-driver.md       # driver subagent persona
│   └── fleet-reviewer.md     # adversarial reviewer persona
├── hooks/hooks.json          # merge-guard PreToolUse registration
├── scripts/
│   ├── merge-guard.ps1       # Windows guard
│   └── merge-guard.sh        # POSIX guard
├── workflows/codex-fleet.js  # the engine (Workflow-tool script)
├── docs/specs/               # this document
└── README.md                 # human-facing install + sandbox + API-key instructions
```

Skills are invoked namespaced: `/codex-fleet:dispatch`, `/codex-fleet:setup`.

## Components

### Engine (`workflows/codex-fleet.js`)

Ported from the working v1 with these changes:

- **`cfg.mode`** (`"codex"` | `"claude"`, default `"codex"`): the engine owns the Claude-only fallback. In `codex` mode, drivers dispatch Codex CLI and are forbidden from editing project source. In `claude` mode (set by dispatch when `authMode: none`), the driver prompt swaps the "dispatch Codex" step for "implement the task spec yourself" — everything else (worktree, verify, correction round, commit, adversarial review, return contract, telemetry inputs) is identical. The fallback is NOT reimplemented in skill prose; the engine is the single owner of the pipeline in both modes.
- **`cfg.codexExe` argument** replaces the hard-coded `CODEX` const — required when `mode` is `codex` (throw early with "run /codex-fleet:setup"), ignored in `claude` mode. Dispatch skill supplies it from machine config.
- **`cfg.platform`** (`"windows"` | `"posix"`) selects idioms inside driver prompts:
  - stdin close: `$null | & <exe> exec ...` (Windows) vs `<exe> exec ... < /dev/null` (POSIX). Without this, `codex exec` hangs forever on piped stdin ("Reading additional input from stdin...").
  - path separators, worktree paths, artifact-cleanup commands (`Get-ChildItem`/`Remove-Item` vs `find`/`rm -rf`).
- **Bundled agent types**: driver `agent()` calls pass `agentType` for the codex-driver definition; reviewer calls for fleet-reviewer. Prompts remain fully self-contained — if agent-type resolution fails in any environment, inline prompts alone still carry the complete procedure (graceful degradation by design).
- Retained v1 behavior (proven, do not regress):
  - args tolerant of object OR JSON-string form
  - per-task isolated worktree on branch `codex/<id>` at `<repo>-codex-wt/<id>`
  - Codex forbidden from git operations; the Claude driver commits
  - `-o` capture file placed NEXT TO the worktree dir (inside it → gets committed)
  - driver purges `__pycache__`-class build artifacts before commit; audits `git show --stat`
  - one correction round max on verify failure; failed-twice → status "failed", hand-fix, never a third dispatch
  - reviews are adversarial, independently re-run tests, verdict approve/needs_work/reject
  - return contract `{results: [{taskId, driver, review}], approvedBranches, worktreeBase}`
  - merging is manual and sequential; never auto-merge *[superseded by A1: integration modes, default `stage`]*

### Setup skill (`skills/setup/SKILL.md`)

Once per machine. Steps:

1. Detect platform.
2. Locate Codex CLI:
   - Windows: parse `CODEX_CLI_PATH` from `~/.codex/config.toml` (the binary path is hash-versioned and drifts on app updates — never hard-code).
   - POSIX: `which codex`; if absent, guided `npm i -g @openai/codex`.
3. Verify headless auth: run the trivial READY smoke (`codex exec 'Reply with exactly: READY'`, read-only sandbox, ephemeral). Classify `authMode`: `subscription` (desktop login), `api_key` (`OPENAI_API_KEY` present and works), `none`.
4. Write `config.json` `{codexExe, platform, authMode, verifiedAt}` to the plugin data directory (`${CLAUDE_PLUGIN_DATA}` — survives plugin updates, never in the repo).
5. `authMode: none` → record it; dispatch will use Claude-only fallback.

### Dispatch skill (`skills/dispatch/SKILL.md`)

The v1 `/fleet` skill generalized:

- Reads `config.json`; missing → instruct running `/codex-fleet:setup` first.
- Spec-writing rules (unchanged from v1): ground specs in actual code first with file/line anchors; surgical single-concern test-anchored tasks; explicit "Do not modify X"; prefer disjoint file sets, pin different insertion anchors when a shared file is unavoidable; never ask Codex to run tests (its sandbox cannot execute local toolchains — driver verifies outside).
- Invokes the engine: `Workflow({scriptPath: '<plugin root>/workflows/codex-fleet.js', args: {repo, mode, codexExe, platform, verify, tasks}})` — `mode` from `authMode` (`none` → `claude`, else `codex`).
- Merge protocol *[superseded by A1 — this v1 flow survives only as `integrate: "commit"` mode]*: clear untracked local build artifacts first; per branch best-verdict-first `git merge --no-ff --no-commit` → `git rm` review-flagged strays → commit; FULL project verification after each merge; abort/drop on failure; worktree remove + branch delete; report.
- **Telemetry (new, C):** after each run, append one JSON line to `${CLAUDE_PLUGIN_DATA}/fleet-log.jsonl` (`{ts, repo, taskIds, verdicts, approvedBranches, subagentTokens}`) and update `${CLAUDE_PLUGIN_DATA}/approved.json` *[flat-string schema and "rewrite" wording superseded by A3: sha-keyed entry objects, read-modify-write, write-before-integrate]* for the merge-guard. `subagentTokens` comes from the harness's workflow-completion usage report (the `subagent_tokens` figure in the task notification), not from the engine's return value; if unavailable, the field is omitted rather than fabricated.
- **Claude-only fallback:** when `authMode: none`, the same pipeline runs with Claude subagents implementing instead of Codex (worktrees, verify, review, merge protocol all identical).

### Agents (`agents/`) — C addition

- `codex-driver.md`: persona/system prompt encoding driver discipline — never edit project source yourself; Codex codes, you orchestrate/verify/commit; structured-output-only final message.
- `fleet-reviewer.md`: adversarial reviewer — trust only the diff, re-run tests independently, reject scope creep.
- Both are refinements, not dependencies: the engine's inline prompts remain complete without them.

### Merge-guard hook (`hooks/`, `scripts/`) — C addition

- PreToolUse hook on shell tools; guard fires only when the command matches `git merge … codex/…`.
- **Repo key canonicalization (writer and reader MUST match):** both the dispatch skill (writing `approved.json`) and the guard scripts derive the key as `git rev-parse --show-toplevel` output with backslashes converted to forward slashes; on Windows, comparison is case-insensitive. No other form is ever used.
- Lookup semantics: repo key absent from `approved.json` entirely → **allow** (the fleet never ran against this repo; fail-open). Repo key present but branch verdict absent, `needs_work`, or `reject` → **block**, with a message naming the verdict and the overrides. The block message must state that the hook gates only Claude's tool calls — the user's own terminal is never affected — and that the path forward is applying the reviewer's fixes or re-running dispatch.
- **Fail-open semantics:** missing state file, unparseable JSON, wrong-platform script, any script error → exit 0 (allow). The hook is a seatbelt; the dispatch skill's merge protocol is the real enforcement. A guard bug must never brick unrelated merges.
- Paired implementations: `merge-guard.ps1` (Windows) + `merge-guard.sh` (POSIX). Each exits 0 immediately when invoked on the wrong platform.
- Hooks do NOT run in cloud sandboxes (platform limitation) — documented, acceptable.

### README

- Two-command install: `/plugin marketplace add wenbinio/claudeorchestratortocodex`, `/plugin install codex-fleet@wenbinio` *[marketplace name resolved per A6]*.
- Sandbox enablement: copy-paste `.claude/settings.json` block (`enabledPlugins` + `extraKnownMarketplaces`) to check into any repo that should have fleet access in claude.ai/code sessions; `OPENAI_API_KEY` as environment secret; note that the merge-guard hook is local-only (skills and agents DO load in sandboxes).
- Requirements: Codex CLI (desktop app on Windows, npm package elsewhere), an OpenAI auth (ChatGPT login or API key), git.
- Honest cost note: Codex usage bills to the user's OpenAI plan; fleet runs also consume Claude tokens.

## Migration (author's machines)

After installing the plugin locally: delete `~/.claude/skills/fleet/`, delete `Downloads\claude\.claude\workflows\codex-fleet.js`, slim CLAUDE.md's Codex Fleet section to a pointer at the plugin + repo. The repo is the single source of truth thereafter. Version field in plugin.json bumped per release; machines update via `/plugin marketplace update`.

## Testing plan (before first release tag)

1. **Engine parity:** re-run the proven fleet-test lifecycle (throwaway git repo, 2 parallel tasks, pre-written failing tests) through the plugin-installed engine path on this machine. Same green outcome required.
2. **Skill GREEN tests:** plan-only subagent given each skill's content must produce the correct invocation, return-contract handling, and merge protocol (method proven in v1 skill development).
3. **Hook test** *[case matrix updated per A3]*: recorded branch + matching sha + `reject` verdict → BLOCK with message (positive discriminating case — a dead guard fails it); matching sha + `approve` → allow; sha-mismatch → allow; repo key absent → allow; unrelated branch → guard silent; corrupt `approved.json` → fail-open; `merge --squash` form → same matrix.
4. **Setup test:** delete `config.json`, run setup, verify discovery + auth classification + rewrite.
5. **Sandbox surface:** verified by documentation/inspection only until the user opens a cloud session on a fleet-enabled repo. Explicitly flagged as the one untested surface at release.

## Known constraints and gotchas (carried from v1 experience)

| # | Constraint | Consequence in design |
|---|---|---|
| 1 | `codex exec` hangs on piped stdin | stdin-close idiom per platform, baked into driver prompts |
| 2 | Codex sandbox cannot execute local toolchains | driver verifies outside; specs must never ask Codex to run tests |
| 3 | `codex.exe` path is hash-versioned, drifts on update | setup re-derives from `CODEX_CLI_PATH`; config.json regenerated |
| 4 | Workflow `args` may arrive JSON-stringified | engine normalizes both forms |
| 5 | `-o` file inside worktree gets committed | capture file placed beside worktree |
| 6 | verify-generated artifacts collide at merge | driver purges pre-commit; merge protocol clears local untracked first |
| 7 | xhigh reasoning exceeds foreground tool timeouts | foreground + resume ladder *[superseded by A4]* |
| 8 | Hooks/monitors inert in cloud sandboxes | guard is local-only seatbelt; skill protocol is the enforcement |
| 9 | Interactive ChatGPT OAuth impossible headless | sandbox auth = API key or Claude-only fallback |

## Out of scope

- MCP server wrapping of Codex (skill+workflow suffices; revisit only if per-call tool permissions become necessary).
- Windows/POSIX-agnostic single-script hooks (paired scripts are simpler than a portable runtime dependency).
- Multi-provider support (Gemini CLI etc.) — the engine's shape would allow it later; not now.

---

# Amendments — 2026-07-18 (post-audit + UX deltas)

Two independent audits (Opus, Codex) and two user-requested UX changes landed after initial approval. These amendments supersede conflicting text above. The original body is retained for review-diff purposes.

## A1. Integration modes — seamless merge (supersedes "manual, sequential" and the auto-merge out-of-scope line)

User requirement: fleet output should land like native in-terminal Claude Code work — edits in the working tree, user reviews `git diff`, user decides when to commit.

`integrate` mode on dispatch, default **`stage`**:

- **`stage` (default):** temp-commit ladder with a final soft reset — the ONLY sanctioned mechanism (naive commitless sequential squashing is mechanically impossible: the first squash dirties the index and every subsequent `git merge` refuses to start).
  1. Precondition: caller's working tree must be clean; dirty → abort integration with a message (never stash silently).
  2. Record `ORIG = HEAD`. Per approved branch in verdict order: `git merge --squash codex/<id>` then a TEMP commit `fleet-stage: <id>`; run FULL project verification.
  3. Red verify → `git reset --hard HEAD~1` (drops only that branch's temp commit; earlier branches' work is safe in ancestor temp commits); squash conflict → `git reset --hard HEAD` after aborting the squash state. Either way the branch is parked and integration continues.
  4. After the last branch: `git reset --soft ORIG` — every integrated change lands as one staged, verified, uncommitted diff; zero commits remain in history.
  5. Report names what integrated and what parked and why. Worktrees + integrated branches auto-cleaned (provenance persists in fleet-log.jsonl); parked branches kept.
  Shared-file batches work naturally — each squash applies onto the previous temp commit.
- **`commit`:** the original per-branch `--no-ff` merge-commit protocol.
- **`manual`:** branches only; no integration.

Safety inversion, not removal: only `approve`-verdict branches integrate in any mode; gates (verify-after-each, park-on-red) replace ceremony.

## A2. Codex worker observability — parity with Claude subagent overviews

User requirement: per-worker prompt/result overviews, tool uses, and transcripts, like Claude agents provide.

- Drivers add `--json` to `codex exec`, teeing the JSONL event stream to `<task-id>.codex-events.jsonl` beside the worktree.
- After each worker: driver distills events into `${CLAUDE_PLUGIN_DATA}/transcripts/<run>/<task-id>.md` with sections PROMPT / TIMELINE (each command Codex ran + exit status, each file patched) / FINAL MESSAGE / USAGE (tokens, duration, session id).
- Driver structured output gains: `codexCommandsRun`, `filesPatched`, `sessionId`, `transcriptPath`.
- Dispatch's end-of-run report shows one overview line per worker + clickable transcript path. Workers are not `--ephemeral`, so sessions also appear natively in the Codex app's session list; `codex exec resume <sessionId>` works for post-hoc interrogation.
- **Wrapper-agent rule: raw-shell Codex dispatches are an anti-pattern.** EVERY Codex invocation — fleet workers, one-off auditors, ad-hoc oneshots — runs inside a thin Claude driver agent, never as a bare background shell call. Rationale (observed): the harness gives agents live narration, token/tool-use counts, and a View-transcript link; a bare shell call renders as an opaque task chip with none of that. The wrapper costs one subagent and buys full observability parity; the dispatch skill must state this rule and provide the one-off dispatch shape.

## A3. Merge-guard redesign (fixes audit findings: name-reuse bypass, rewrite ambiguity, matcher gap, arbitration, env fallback, stale-verdict dead end, undetectable-dead-guard)

- **Verdicts key on branch TIP SHA, not name:** `approved.json` entries are `{"<canonical-repo-key>": {"codex/<id>": {"sha": "<tip-sha>", "verdict": "..."}}}`. Guard compares the CURRENT tip of the named branch to the recorded sha; mismatch → treat as key-absent (allow, fail-open). This kills the branch-name-reuse bypass AND auto-resolves the stale-reject dead end (hand-fixed branch = new sha = no stale block).
- **approved.json updates are read-modify-write merges** — never whole-file overwrite; other repos' entries must survive.
- **Matcher explicitly enumerates both shell tools**: `Bash|PowerShell`. Both guard scripts are registered; PreToolUse semantics make any exit-2 win over any exit-0 (block wins). The `.sh` detects Windows (`uname` → `MINGW*|MSYS*|CYGWIN*`) and exits 0 immediately; the `.ps1` is inherently Windows-gated by its interpreter.
- **Data-dir resolution in guards must not depend on `${CLAUDE_PLUGIN_DATA}` reaching the hook environment**: scripts try the env var, then fall back to `~/.claude/plugins/data/codex-fleet/`. This assumption is explicitly flagged VERIFY-AT-BUILD.
- **Honest coverage statement (docs + README):** the guard matches `git merge` of `codex/*` only; rebase/cherry-pick/pull bypass it; it gates only Claude's tool calls. It is an advisory seatbelt. The dispatch skill's protocol is the enforcement.
- **Write-before-integrate ordering (A1 interaction):** the dispatch skill updates `approved.json` from the engine's verdicts BEFORE integration begins — never after. Otherwise, on any repo with entries from a prior run, the guard sees a present repo key with the new branches absent and blocks the skill's own apply commands. The guard matches both `git merge` and `git merge --squash` of `codex/*` branches; stage-mode applies passing the guard (approve + sha match → allow) is by design.
- **Positive discriminating test required:** seed a real branch + recorded `reject` with matching sha, attempt the merge via Claude's shell tool, and REQUIRE the block message. A dead guard fails this test. (The corrupt-file fail-open test alone cannot distinguish working from dead.) Full guard test matrix: name+sha+bad-verdict → block; sha-mismatch → allow; repo-key absent → allow; `merge --squash` form → same behaviors.

## A4. Review and driver-protocol hardening (fixes: emergent-behavior overclaim; StructuredOutput dropout — observed live when 4/5 drivers orphaned their workers)

- **Reviewer prompt MANDATES independently re-running the task's verify command** (v1 only implied it in skill prose; v1 engine never instructed it — reviewers did it voluntarily; v2 makes it a hard instruction). Verdict `approve` requires the reviewer's own green run.
- **Codex dispatch runs FOREGROUND** with explicit tool timeout (≤10 min); `run_in_background` is forbidden inside workflow drivers (observed failure: driver ends turn awaiting notification → harness treats as complete → worker orphaned, output lost).
- **Long-worker policy (resolves the tension with constraint #7, which this supersedes):** a worker that hits the 10-min foreground window is continued, not abandoned — the driver kills the timed-out process and runs `codex exec resume <sessionId> "continue"` (sessionId is available early from the A2 `--json` stream) for at most ONE additional 10-min window. Still unfinished after two windows → task failed with explicit "decompose this task" guidance in the report. Task specs may also pass a lower reasoning effort (`-c model_reasoning_effort=high`) for mechanical work. Constraint #7's row now points here.
- **Always-report rule:** the driver's final action MUST be the StructuredOutput call — on any failure, interruption, or nudge, report `status: "failed"` with best-available fields; never end in prose.
- **Recovery principle:** the worktree + branch state is ground truth; a lost driver report must be recoverable by inspecting git state, and the dispatch skill's report step must fall back to that when structured output is missing.

## A5. POSIX port scope correction

The v1 driver prompt is pervasively PowerShell (~10 backslash-joined paths, `New-Item`/`Get-ChildItem` idioms, `$null | &` operator). The port is NOT three token swaps: the v2 engine composes the driver prompt from platform-conditional blocks (command idioms, path joins, cleanup, stdin-close) with the shared logic written once. Task specs for the engine build must say this explicitly.

## A6. Hygiene and bookkeeping

- Reference docs sanitized (`<user>` placeholders; no real usernames/machine paths in the public repo). LICENSE: MIT (author wenbinio).
- Marketplace name resolved: **`wenbinio`** — threaded through marketplace.json, README install commands, and the sandbox settings block (no `<marketplace-name>` placeholders anywhere).
- v1 nuances now documented as intentional: failed-twice branches still commit (so reviewers/park-lists can inspect them) but can never auto-integrate (verdict gate); `diffStat` assumes a single branch commit.
- Cloud note: data-dir persistence in sandboxes is unverified; setup may need to re-run per cloud session (cheap: discovery + READY smoke).
- **Testing plan additions:** positive guard block test (A3); claude-mode fallback end-to-end run (previously untested entire code path); stage-mode integration test (apply + park-on-red). **Honest untested-at-release list:** POSIX driver path, second-Windows-machine path, cloud sandbox surface — first real runs on those environments are the test, and the README says so.
