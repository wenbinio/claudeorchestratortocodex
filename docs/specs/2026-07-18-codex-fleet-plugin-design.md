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

## A7. Post-audit hardening (independent Codex-model audit, 17 findings + verified platform facts)

1. **Runtime portability (CRITICAL fix):** the `Workflow` tool is NOT a documented stock Claude Code capability — the engine script alone does not make the plugin work off this machine. Dispatch becomes **dual-path, both normative**: (a) when the Workflow tool exists, invoke the engine via scriptPath as designed; (b) otherwise, the dispatch skill itself orchestrates the identical pipeline with parallel Agent-tool subagents (driver agents + reviewer agents, same prompts/contract/verdicts). Path (b) must be fully specified in dispatch/SKILL.md — it is the guarantee that the plugin's core feature exists on every stock installation; the engine is the deterministic accelerator, not the definition.
2. **Worker invocation pinning:** every `codex exec` passes the model and reasoning effort explicitly (`-m` + `-c model_reasoning_effort=...`) from config.json fields (`model` default `gpt-5.6-sol`, `effort` default `xhigh`; per-task override allowed). Never inherit the machine's Codex defaults silently.
3. **Discovery/auth hardening (setup):** discovery order = PATH (`which codex` / `Get-Command codex`) → Windows `CODEX_CLI_PATH` parse → guided npm install. Dispatch re-validates the recorded exe exists before every run (hash-versioned paths go stale on app update → auto re-run discovery). Auth check prefers `codex login status` where available; headless API-key login is documented for sandboxes.
4. **No-verify policy:** a task without a verify command is marked `unverified` (v1 silently set verifyPassed=true — a hole). Unverified branches are NEVER auto-integrated in stage mode — parked with reason — unless the task carries an explicit `allowUnverified: true`.
5. **Timeout termination:** on a foreground window timeout, the driver performs process-TREE termination (`taskkill /T /F` on Windows, process-group kill on POSIX) and confirms death before opening the resume window — no concurrent writers on one worktree, ever.
6. **Agent-type resolution:** the engine/dispatch catches a failed spawn with a scoped agentType (`codex-fleet:codex-driver`) and retries once without agentType. Resolution failure must never kill a task.
7. **Stage-ladder transactionality:** before each rung, assert HEAD equals the previous rung's commit (abort integration cleanly on mismatch — something else moved HEAD). ORIG and per-rung shas are journaled to fleet-log.jsonl BEFORE integration starts; temp commits carry the identifiable `fleet-stage:` prefix; documented crash recovery = `git reset --soft <journaled ORIG>`. Every controlled exit path ends at ORIG or a verified rung, never mid-squash.
8. **Guard semantics v2 (supersedes A3's mismatch→allow):** a RECORDED branch whose current tip sha differs from the reviewed sha → **BLOCK** as "stale review — branch changed since review; re-run dispatch to re-review, or merge from your own terminal." Fail-open (allow) is reserved for: unknown repo, unknown branch, and infrastructure errors (missing/corrupt state, no git). This closes the amend-one-commit re-approval bypass; the stale-reject dead end stays solved because the block message names both exits.
9. **Repo identity for the guard:** derive the target repo from the merge command itself — honor `git -C <path>` when present, else the hook's cwd — and canonicalize via `git rev-parse --git-common-dir` resolved to an absolute forward-slash path (stable across linked worktrees; `--show-toplevel` is not). Writer (dispatch) uses the identical derivation. approved.json writes are atomic (temp file + rename) with a best-effort lock; readers still fail open on partial/corrupt state.
10. **Data-dir resolution:** the exact on-disk id format for marketplace-installed plugins is undocumented. Resolution order everywhere: `$CLAUDE_PLUGIN_DATA` env var → glob `~/.claude/plugins/data/*codex-fleet*/` (accepts plugin-name or marketplace-qualified forms) → fail-open (guards) / instruct setup (skills). Setup records the resolved path as `resolvedDataDir` in config.json.
11. **Hooks DO run in cloud sessions** (verified against current docs — supersedes every "hooks are local-only" claim in this spec and in plugin-facts.md; earlier research was stale). Repo-level AND plugin hooks fire the same events in cloud; `CLAUDE_CODE_REMOTE=true` is set there. The merge-guard is therefore cross-surface; cloud guard behavior joins the honest untested-at-release list (unverifiable from this machine).
12. **Reviewer agent enforcement:** fleet-reviewer.md frontmatter restricts tools mechanically (no Write/Edit/NotebookEdit; shell retained for independently re-running verify). Driver prose drops the universal "Codex cannot execute local toolchains" claim in favor of "verification is the driver's job, outside Codex's sandbox" (the observed limitation is host-specific).
13. **Task-id validation:** engine rejects task ids not matching `^[a-z0-9][a-z0-9-]{0,40}$` and rejects duplicate ids in one batch. Existing-branch collision on dispatch is an ERROR (park and report), not a silent delete — v1's delete-and-recreate destroyed unmerged prior work.
14. **plugin-facts.md corrected** (manifest requires only `name`; no placeholders; workflow-runtime caveat added; cloud-hooks claim fixed).
15. **Attribution decision surfaced to user before push:** commits carry the author's real name + GitHub noreply address. User decides keep vs re-author; push is gated on that answer.

## A8. v0.2 — app-server backend + standalone runner

**Sourcing (user directive escalated "steal" → "copy"):** the app-server transport and sessionful-worker layer are **vendored verbatim** from scasella/claude-dynamic-workflows-codex (MIT, © Stephen Casella) under `vendor/dynamic-workflows-codex/`, NOT reimplemented. Upstream `LICENSE` is preserved in that directory and `NOTICE.md` records the exact upstream commit (`16524bea…`), the copied file set, and any local modifications. MIT compliance = their copyright + permission notice travel with the code; codex-fleet claims no authorship of vendored files. The binary-generated protocol schemas under `docs/reference/app-server/` remain our own ground truth and are used to validate the vendored client against this Codex version.

**Ground truth (committed under `docs/reference/app-server/`):** protocol schemas generated by our own binary (`codex app-server generate-json-schema`, v0.145.0-alpha.18) + a live wire transcript (`live-probe-transcript.jsonl`) captured 2026-07-19: `initialize` {clientInfo{name,version}} → `thread/start` {cwd, ephemeral?, sandbox} → result `.thread.id` → `turn/start` {threadId, input:[{type:"text",text}], model?, effort?, sandboxPolicy?, outputSchema?} → notifications `thread/started`, `turn/started`, `item/started`, `item/agentMessage/delta`, `item/completed`, `thread/tokenUsage/updated`, `turn/completed`. Corrections: `turn/steer` {threadId, expectedTurnId, input}. Timeouts: `turn/interrupt` {threadId, turnId}. JSON-RPC 2.0, newline-delimited, over the spawned process's stdio.

**Why:** replaces `codex exec` process-wrangling for workers — eliminates the stdin-close hang, the 10-minute shell-tool ceiling (runner owns its own timeouts via `turn/interrupt`), process-tree kills, and orphaned workers; correction rounds become sessionful `turn/steer` on a warm thread (cheaper + context-preserving); all deterministic mechanics (worktrees, verify, commit, purge, transcripts) move from LLM prose into code; and the runner IS the definitive stock-install portability answer (any machine with Node ≥18, no Workflow tool needed).

**Components (v0.2):**

1. **App-server client — VENDORED, not built:** `vendor/dynamic-workflows-codex/src/appServerClient.js` (upstream `AppServerClient`, an EventEmitter over `codex app-server` JSON-RPC) and `codexSession.js` (sessionful thread/turn driver) are used as-is. Our `runner/fleet-runner.js` imports them. The API our adapter relies on is upstream's; the contract below documents what WE call into, for the adapter author — it is a description of vendored behavior, not a reimplementation target:
   - `createClient({codexExe, logPath}) -> client` — spawns `codexExe app-server`, wires ndjson framing, logs every wire message to logPath when set.
   - `client.initialize({name, version}) -> Promise<result>`
   - `client.threadStart({cwd, sandbox, model, ephemeral}) -> Promise<{threadId}>`
   - `client.turnStart({threadId, prompt, model, effort, outputSchema}) -> Promise<{turnId}>` (prompt wrapped as `[{type:'text',text:prompt}]`)
   - `client.turnSteer({threadId, expectedTurnId, prompt}) -> Promise<void>`
   - `client.turnInterrupt({threadId, turnId}) -> Promise<void>`
   - `client.waitForTurnEnd({threadId, turnId, timeoutMs, onEvent}) -> Promise<{status:'completed'|'interrupted'|'failed', finalMessage, tokenUsage, commandsRun, filesPatched}>` — resolves on `turn/completed`-class notifications; on timeout calls `turnInterrupt` itself then resolves `'interrupted'`; `onEvent` receives every thread-scoped notification (for JSONL capture).
   - `client.close()` — graceful child shutdown, force-kill fallback.
   - Server-initiated requests (approvals) are answered with a safe default decline and logged (fleet threads run sandboxed and should never need approvals).
2. **`runner/fleet-runner.js`** — CLI: `node fleet-runner.js --batch <batch.json>`. Batch: `{repo, tasks:[{id,spec,verify?,allowUnverified?}], verify, model, effort, codexExe, wtBase?, transcriptDir?, maxParallel?, timeoutMinutes?}`. Executes the ENTIRE dispatch phase deterministically per task: id validation (same regex/dup/collision rules as the engine, collision = task error not delete) → worktree add `codex/<id>` → thread/start (cwd=worktree, sandbox `workspace-write`) → turn/start (composed prompt = spec + the v1 appended constraints) → events streamed to `<id>.codex-events.jsonl` beside the worktree → `waitForTurnEnd` (default timeout 15 min — no shell ceiling) → run verify via child_process in the worktree (absent verify → mark `unverified`) → red: ONE `turn/steer` correction with the failure tail, re-verify → artifact purge (`__pycache__`-class dirs) → `git add -A` + commit + `show --stat` audit (strip strays, amend) → transcript markdown (PROMPT/TIMELINE/FINAL MESSAGE/USAGE, from events) → per-task result in the v1 driver-report schema. Tasks run concurrently up to `maxParallel` (default 4). Output: `results.json` `{results:[...], approvedBranches:[], worktreeBase}` where approvedBranches is left EMPTY (review happens after; the field exists for shape compatibility) + exit 0 even with failed tasks (failures are data). Journaling: append-only `runner-journal.jsonl` for resume diagnostics. No `Date.now` restrictions here (plain Node, not a workflow script).
3. **`viewer/fleet-viewer.html`** — fully self-contained static HTML (inline CSS/JS, zero external requests): drag-drop or file-pick `results.json` / `fleet-log.jsonl` / transcript `.md` files; renders run overview cards (task, status, verdict, tokens, duration) and a per-task timeline pane from transcripts. Dark theme, compact.
4. **Integration:** dispatch skill v2 — backend order: (1) runner (`config.backend === 'app-server'` and node present): ONE shell command executes the whole dispatch phase, then Claude spawns reviewer agents per branch and proceeds with verdict-state + integration ladder unchanged; (2) engine workflow (Workflow tool present); (3) prose Agent-tool orchestration. Setup v2: detect node ≥18 (`node --version`), set `backend` (`app-server` default when available, else `exec`) + `nodeExe` in config.json. README: v0.2 features, Node requirement (optional but recommended), runner CLI usage standalone. plugin.json `0.2.0`.

**Review/verdict/integration layers are UNCHANGED** — reviewers still independently re-run verifies; approved.json, guard, and the stage ladder are untouched by A8.

**Compatibility:** the `codex exec` path and the v0.1 engine remain fully supported (machines without Node). The runner is additive.

**Credit:** README states plainly that the app-server transport + sessionful-worker layer is vendored from scasella/claude-dynamic-workflows-codex under MIT (© Stephen Casella), links the upstream repo, and points at `vendor/dynamic-workflows-codex/{LICENSE,NOTICE.md}`. Not framed as our own work.

## A9. v0.3 — unify to one runner-first lifecycle + close verified defects

Two independent improvement passes (GPT-5.6-Sol read-only; Fable full-context) converged: the dual engine is the core debt, vendor usage is thinner than documented, and the runner has real correctness gaps. This amendment supersedes A8's parallel-engine framing.

### Architecture decision (both models, independently)
- **Runner-first, ONE code lifecycle.** The pipeline (worktree → turn(s) → quiescence → verify → one correction → checked commit → transcript) lives ONCE in `runner/task-runner.mjs`. Only "run a Codex turn" varies, behind a transport interface. `workflows/codex-fleet.js` is DEMOTED to `docs/reference/` (no longer a normative backend); the Agent-tool prose fallback in dispatch remains for no-Node stock installs and Claude-only mode.
- **Adopt the vendored `codexSession.js`** for the app-server transport (retries, real interrupted-vs-failed outcome, token metering) instead of the hand-rolled turn loop. Correct the A8/NOTICE claim accordingly.

### Frozen module contracts (workers code against these; parallel-safe)
- **Transport** (`runner/transports/{app-server,exec}.mjs`), each exports:
  `async function createWorker({codexExe, cwd, model, effort, onEvent}) -> { async turn(prompt, {timeoutMs}) -> {status:'completed'|'failed'|'interrupted', finalMessage, commandsRun, filesPatched, tokenUsage, sessionId}, async close() }`. app-server wraps vendored `codexSession.js`; exec shells `codex exec` with the `$null|`/`</dev/null` idiom.
- **Core** (`runner/task-runner.mjs`) exports:
  `async function runTask({repo, baseSha, task, verify, transport, wtBase, transcriptDir, timeoutMs}) -> driverReport` (same driver-report schema as today plus `baseSha`, `commitSha`). Owns all deterministic steps; calls `transport.turn()` only for implementation + correction.
- **CLI** (`runner/fleet-runner.mjs`) becomes a thin adapter: parse batch, resolve `baseSha` ONCE, select transport by `cfg.backend`, run the pool, write run-state EXTERNALLY.

### Verified defects each task MUST fix (all confirmed against shipped code)
1. **Turn quiescence (HIGH):** wait on the SPECIFIC `{threadId,turnId}` terminal event, honor `turn.status`, distinguish completed/failed/interrupted/timed_out. On timeout: interrupt, then wait a grace period for the terminal event, then kill the process tree — NEVER verify while the writer is live. Attach the listener BEFORE `turn/start` (fast-completion race).
2. **Checked git (HIGH):** `mustGit()` with typed errors; snapshot `baseSha` once; all worktrees created at `baseSha`; require nonempty staged diff; require commit exit 0; assert `commitSha !== baseSha` and `commitSha^ === baseSha`; audit with explicit `commitSha`, never ambient HEAD/HEAD~1. One task's failure must not abort the pool.
3. **Async subprocesses (HIGH):** replace `spawnSync` with async `spawn`/`execFile` (bounded output tails, explicit verify timeout, tree-kill) so a verifier can't stall other workers; serialize the short `git worktree add` critical section.
4. **Run-state OUT of the repo (HIGH):** batch gains `runId` + `outDir`; results/journal/events/transcripts go under `${CLAUDE_PLUGIN_DATA}/runs/<runId>/` (or explicit external dir), atomic temp+rename. Fixes the self-contradiction where the preferred backend dirties the tree stage-mode requires clean.
5. **Approvals denied (HIGH):** app-server transport passes `approvalPolicy:"never"` + an explicit request handler that rejects permission-escalation/dynamic-tool/unknown server requests; worktree/git restrictions go in `developerInstructions`, not just user text.
6. **Real event parsing (HIGH):** delete the no-op `threadId` filter; switch on `commandExecution`/`fileChange`/`agentMessage`; record exit codes, file paths, `phase==='final_answer'`; idempotent collector shutdown that awaits stream `finish`; write a transcript on EVERY terminal path (failure/timeout/no-change).
7. **Verifier-mutation isolation (HIGH):** snapshot the worker diff BEFORE verify; after verify, restore verifier-only mutations (a formatter/test that rewrites tracked files must not land in the commit); optional `allowedFiles`/`excludedFiles`.
8. **Guard hardening (HIGH):** PowerShell AST on Windows, a real POSIX tokenizer on sh; recognize `git -C`/global opts/`refs/heads/…`; canonicalize repo identity from the merge command's target via `--git-common-dir`; keep "advisory tripwire" framing.
9. **Atomic verdict store (HIGH):** `scripts/verdict-store` helper — lock, read-modify-write, fsync, atomic rename; store `reviewVerdict`+`driverVerifyPassed`+`reviewVerifyPassed`+`allowUnverified`+derived `eligible`; guard requires `eligible===true`.
10. **Setup capability probe (MED):** `fleet-runner.mjs --probe` does initialize + model list + one ephemeral read-only turn; pick `exec` when the app-server probe fails; re-probe on version change.
11. **Dispatch backend gating (MED):** select app-server ONLY when `mode==='codex'` AND `codexExe`+`nodeExe` exist AND probe compatible; invoke the ABSOLUTE `nodeExe`; specify the exact runner-result → `{taskId,driver,review}` normalization; delete the temp batch after read.
12. **Portability (MED):** separate `Bash` and `PowerShell` hook matcher entries; declare/verify `jq` (or drop it); strict-POSIX or explicit `bash`; centralize data-dir resolution.

### Doc corrections (verified falsehoods — fix regardless)
- README "SHA mismatches fail open" is FALSE — guards block-on-stale (A7.8). Correct it.
- A8 + `vendor/.../NOTICE.md` "codexSession.js used as-is" is FALSE at v0.2 — only `appServerClient.js` was imported. v0.3 makes it true (adopts codexSession); update both docs to describe reality at the shipped version.

### Test harness (Fable's #2 — the unlock)
`test/mock-app-server.mjs`: a fake `codex` that speaks the app-server handshake and replays `docs/reference/app-server/live-probe-transcript.jsonl`. `test/runner.test.mjs` drives `fleet-runner.mjs` against it in a throwaway git fixture asserting worktree layout, verify/correction, strip-strays, checked-commit, transcript shape, results schema, blocked/collision paths. Guard matrix scripted (A3/A7.8). `package.json` `npm test` runs it; `.github/workflows/ci.yml` on ubuntu+windows. Also gives the self-hosting repo its missing verify command (unhobbles stage-mode on its own dogfood).

### Out of scope for v0.3 (deferred, logged)
Reviewer-steer round (Fable #4), crash `--resume` (Fable #3), live supervision dashboard (Fable #5), commit provenance trailers (Fable #7) — all valuable, all sit cleanly on the unified core once it exists. `plugin.json` → `0.3.0`.
