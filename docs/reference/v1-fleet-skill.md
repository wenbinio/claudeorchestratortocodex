---
name: fleet
description: Use when the user wants Codex/GPT-5.6-Sol/Codex CLI to execute coding tasks under Claude orchestration â€” "dispatch the fleet", "have codex do it", "send this to codex", or any batch of parallel implementation work delegated to GPT workers.
---

# Codex Fleet

Claude plans, reviews, and merges; Codex CLI (`gpt-5.6-sol` @ xhigh) writes the code. Engine: `C:\Users\<user>\Downloads\claude\.claude\workflows\codex-fleet.js`.

## Dispatch

Use the **Workflow tool** â€” not Skill, not raw Bash:

```
Workflow({
  scriptPath: 'C:\\\\Users\\\\<user>\\Downloads\\claude\\.claude\\workflows\\codex-fleet.js',
  args: { repo, verify, codexTimeoutMin, tasks: [{id, spec, verify?}] }
})
```

`name: 'codex-fleet'` may not resolve; `scriptPath` always works. `args` may be an object or JSON string (script tolerates both). `repo` must be a git repo with â‰¥1 commit.

## Writing task specs

- Ground specs in the actual code FIRST â€” read the repo, cite exact files/line anchors in the spec.
- Surgical and single-concern; test-anchored ("make tests/test_x.py pass"); explicit "Do not modify X".
- Prefer tasks with **disjoint file sets**. If two tasks must touch one shared file, pin DIFFERENT insertion anchors in each spec and expect one small conflict at merge.
- Codex's sandbox **cannot execute local Python/Godot binaries** â€” never ask Codex to run tests; the Claude driver verifies outside the sandbox.

## Verify commands (driver runs them inside the worktree)

- 3k-imsim-godot: gdlint + headless smoke chain per CLAUDE.md verification pipeline
- Python projects: `& 'C:\Users\<user>\AppData\Local\Python\pythoncore-3.14-64\Scripts\pytest.exe' -q <tests>`

## Return contract

`{results: [{taskId, driver, review}], approvedBranches, worktreeBase}` â€” branch `codex/<id>`, worktree preserved at `<repo>-codex-wt\<id>`, **driver already committed**. Reviews are adversarial and re-run tests independently: trust `review.verdict` over the driver's self-report.

## Merge protocol (manual, sequential â€” never auto-merge)

1. First delete local untracked build artifacts (`__pycache__`, caches) in the main repo â€” they collide with branch-tracked files and abort the merge.
2. Per branch, best verdict first: `git merge --no-ff --no-commit codex/<id>` â†’ `git rm` any review-flagged stray files â†’ commit.
3. Run the FULL project verification after EACH merge. Failure â†’ `git merge --abort`, fix or drop that branch before the next.
4. `needs_work` verdict: apply the reviewer's prescribed fixes in the merge commit, or skip the branch and do it by hand.
5. Cleanup: `git worktree remove --force <repo>-codex-wt\<id>` per task, `git branch -D codex/<id>`, then report what shipped.

## Failure handling

- Task failed verify twice (correction round spent): fix by hand â€” never a third dispatch.
- "codex-fleet needs args" throw: args string wasn't valid JSON.
- codex.exe path is version-hashed and drifts on app update: re-derive from `CODEX_CLI_PATH` in `~/.codex/config.toml` and update the `CODEX` const in the workflow script.
