# Directory submission blurbs

**For the owner to submit manually.** These are drafts for two Claude Code plugin directories. Nothing here has been submitted. Confirm each directory's current field names and submission process before pasting — the fields below are the common shape (name, one-liner, description, tags, links).

Repo: https://github.com/wenbinio/claudeorchestratortocodex
License: MIT
Version at drafting: 0.3.0

---

## claudecodexplugins.com

**Name:** Codex Fleet

**One-liner:** Claude orchestrates Codex workers to write code, with adversarial review and merge gating before anything lands in your repo.

**Description:**
Codex Fleet is a Claude Code plugin that treats LLM-generated code as an untrusted supply chain. You describe the work; Claude drafts grounded, single-concern task specs and dispatches OpenAI Codex (`gpt-5.6-sol`) workers in parallel, each in its own isolated git worktree. The Claude driver verifies each result *outside* Codex's sandbox, and a separate adversarial reviewer re-runs that verification independently before approving. Only approved work integrates — the default stage mode applies branches in verdict order, verifies after each, parks failures, and collapses the rest into one clean staged diff in your working tree (no fleet commits in your history). A SHA-keyed merge-guard hook blocks Claude-tool merges of any `codex/*` branch that hasn't been approved for its exact tip. v0.3 runs on a unified runner-first lifecycle with two backends (sessionful app-server over JSON-RPC when Node ≥ 18, `codex exec` otherwise), a hermetic mock test suite, and CI on Ubuntu + Windows. Falls back to Claude subagents running the identical pipeline when no Codex auth is present. The app-server transport is vendored (MIT) from scasella/claude-dynamic-workflows-codex.

**Install:**
```
/plugin marketplace add wenbinio/claudeorchestratortocodex
/plugin install codex-fleet@wenbinio
/codex-fleet:setup
```

**Tags:** claude-code, codex, multi-agent, orchestration, code-review, git-worktrees, verification, gpt-5.6-sol, plugin, adversarial-review

**Repo URL:** https://github.com/wenbinio/claudeorchestratortocodex

---

## claudepluginhub.com

**Name:** Codex Fleet

**One-liner:** A git-native code-delivery pipeline: Claude plans and reviews, Codex writes, and nothing merges until an adversarial reviewer independently re-runs your tests.

**Description:**
Codex Fleet delegates coding tasks to OpenAI Codex (`gpt-5.6-sol`) workers under Claude Code orchestration — with a hard gate between the model's output and your repo. Each task runs in an isolated git worktree; the Claude driver verifies outside Codex's sandbox; an adversarial reviewer re-runs verification independently and votes approve / needs_work / reject; and only approved branches integrate as a single verified, staged diff you inspect and commit yourself. A SHA-keyed merge-guard hook backs it up by blocking Claude-tool merges of unreviewed `codex/*` branches (advisory — it never touches your own terminal). Two skills (`setup`, `dispatch`), two agents (`codex-driver`, `fleet-reviewer`), one runner-first lifecycle with app-server and `codex exec` transports, a hermetic mock test suite, and Ubuntu + Windows CI. Works in cloud sandboxes via a checked-in settings block; falls back to Claude subagents when Codex auth is absent. Unlike a general Codex-workflow runtime, Codex Fleet is purpose-built for delivering *verified* code into a git repo.

**Category:** Development / Multi-agent orchestration

**Install:**
```
/plugin marketplace add wenbinio/claudeorchestratortocodex
/plugin install codex-fleet@wenbinio
/codex-fleet:setup
```

**Tags:** claude-code, codex, code-delivery, worktrees, adversarial-review, merge-guard, staged-integration, multi-agent, mit

**Repo URL:** https://github.com/wenbinio/claudeorchestratortocodex

**Attribution note (for any "credits" field):** App-server transport vendored from scasella/claude-dynamic-workflows-codex (MIT, © Stephen Casella).

---

## Notes for the submitter

- Both directories may have their own required fields (author handle, screenshot/GIF, demo link). The demo GIF from `demo-script.md` fits a "media" field if one exists.
- Keep the version number current if you submit after a further release.
- Double-check the exact directory domain/URL and submission mechanism before posting — these two site names were provided as targets; verify they're live and accepting submissions.
- Do **not** overstate: avoid "secure" (the guard is advisory) and avoid implying the POSIX/second-machine/cloud paths are battle-tested.
