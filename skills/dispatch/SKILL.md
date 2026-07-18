---
name: dispatch
description: Use when the user asks Claude to delegate coding tasks to Codex CLI, dispatch a Codex fleet, run parallel GPT worker implementation, or integrate the results of a codex-fleet run.
---

# Dispatch Codex Fleet

Plan the work, run the bundled fleet workflow, record its verdicts, and integrate only approved branches.

## Load configuration and inputs

1. Resolve the data directory to `${CLAUDE_PLUGIN_DATA}` when it is available; otherwise use `~/.claude/plugins/data/codex-fleet/`.
2. Read `config.json` from that directory. If it is missing, stop and run `/codex-fleet:setup` first, then re-read it. Do not guess a Codex path or authentication mode.
3. Require `repo` to name a git repository with at least one commit. Resolve `verify` to the full-project verification command and `tasks` to objects shaped like `{id, spec, verify?}`.
4. Set `mode` from `authMode`: use `claude` when it is `none`, and `codex` for `subscription` or `api_key`. Pass through `codexExe` and `platform`. The workflow, not this skill, owns the Claude-only fallback pipeline.
5. Accept `integrate: stage | commit | manual`; default to `stage`.

## Write grounded task specs

Inspect the actual repository before drafting any task. Every spec must:

- Cite exact files and stable line or symbol anchors found in the current code.
- Be surgical, single-concern, and anchored to a specific test or acceptance condition.
- State the allowed files and explicit exclusions such as `Do not modify <path>`.
- Prefer a file set disjoint from every other task. If a shared file is unavoidable, give the tasks different insertion anchors and anticipate a small integration conflict.
- Tell Codex what to implement, but never ask Codex to run tests or local toolchains. Codex's sandbox cannot do that reliably; the Claude driver runs verification outside it.

## Invoke the workflow

Use the Workflow tool, never a raw shell replacement:

```javascript
Workflow({
  scriptPath: '${CLAUDE_PLUGIN_ROOT}/workflows/codex-fleet.js',
  args: {
    repo,
    mode,
    codexExe,
    platform,
    verify,
    tasks,
    agentTypes: {
      driver: 'codex-fleet:codex-driver',
      reviewer: 'codex-fleet:fleet-reviewer'
    }
  }
})
```

Expect `{results: [{taskId, driver, review}], approvedBranches, worktreeBase}`. Trust the adversarial review verdict over the driver's self-assessment. An `approve` verdict is valid only after the reviewer independently re-runs the task's verify command and gets green.

## Enforce worker observability

Every Codex invocation, including fleet workers, one-off auditors, and ad-hoc one-shots, must run inside a thin Claude driver agent. Never launch Codex as a bare background shell call. For a one-off, use this shape:

```javascript
agent({
  agentType: 'codex-fleet:codex-driver',
  prompt: `ONE-OFF CODEX JOB
Repository: <repo>
Task: <grounded task>
Run Codex in the foreground with --json, closed stdin, and a timeout of at most 10 minutes.
Tee its events, write the transcript, and finish with StructuredOutput.`
})
```

The driver tees each `--json` event stream to `<task-id>.codex-events.jsonl` beside the worktree and distills it to `${CLAUDE_PLUGIN_DATA}/transcripts/<run>/<task-id>.md`. Preserve the non-ephemeral Codex session and collect `codexCommandsRun`, `filesPatched`, `sessionId`, and `transcriptPath` in structured output.

Run Codex in the foreground with an explicit timeout of at most 10 minutes; `run_in_background` is forbidden inside drivers. If that window expires, kill the timed-out process and use the session ID already emitted in the JSON stream to run `codex exec resume <sessionId> "continue"` for at most one additional 10-minute foreground window. If it is still unfinished, mark the task failed and report that it should be decomposed. Mechanical tasks may lower reasoning effort with `-c model_reasoning_effort=high`.

The driver's final action must always be StructuredOutput. On failure, interruption, or nudge, it must report `status: "failed"` with every available field and never end in prose. If structured output is missing, reconstruct the best available status from the worktree and branch, which are the ground truth.

## Record verdict state before integration

Do all of the following after the workflow returns and before the first integration command:

1. In `repo`, run `git rev-parse --show-toplevel`; trim the output and replace every backslash with `/`. Use only this value as the canonical repository key. Guard comparisons on Windows are case-insensitive.
2. For each reviewed `codex/<id>` branch, resolve its current tip SHA and create the entry `{"sha": "<tip-sha>", "verdict": "<verdict>"}`.
3. Read `${dataDir}/approved.json`, or start with `{}` when it does not exist. If an existing file cannot be parsed, do not destroy it and do not begin integration; report the state-write failure.
4. Perform a read-modify-write merge under the canonical repository key. Preserve every other repository and every unrelated existing branch entry. Never replace the file with a current-run-only object. The resulting schema is:

   ```json
   {
     "<canonical-repo-key>": {
       "codex/<id>": {"sha": "<tip-sha>", "verdict": "approve"}
     }
   }
   ```

5. Persist the merged `approved.json` before integration begins. This ordering is mandatory for both ordinary merges and `git merge --squash`.

Only branches whose current review verdict is `approve` may integrate. Park `needs_work`, `reject`, failed, missing-review, and verify-red branches.

## Integrate

### `stage` (default)

Use the temp-commit ladder and no other stage mechanism:

1. Precondition: the caller's working tree must be clean; if dirty, abort integration with a message. Never stash silently.
2. Record `ORIG = HEAD`. Per approved branch in verdict order: run `git merge --squash codex/<id>`, then create a TEMP commit `fleet-stage: <id>`, then run FULL project verification.
3. If verification is red, run `git reset --hard HEAD~1`; this drops only that branch's temp commit while earlier branches remain safe in ancestor temp commits. If the squash conflicts, abort the squash state and run `git reset --hard HEAD`. In either case, park that branch and continue.
4. After the last branch, run `git reset --soft ORIG`. Every integrated change now appears as one staged, verified, uncommitted diff, and no temp commit remains in history.
5. Report exactly which branches integrated and which parked, with the reason for each parked branch. Remove the fleet worktrees and delete integrated branches; keep parked branches.

This ladder also handles shared-file batches because each squash applies on top of the preceding temp commit.

### `commit`

Use the original sequential merge-commit protocol. Clear collision-prone untracked build artifacts in the main repository. For each approved branch in verdict order, run `git merge --no-ff --no-commit codex/<id>`, remove review-flagged stray files, commit the merge, and run FULL project verification. If verification fails, undo only that branch's merge, park it, and continue safely. Remove completed worktrees and integrated branches; keep parked branches. This mode intentionally leaves merge commits.

### `manual`

Do not apply or merge any branch. Leave the branches for the user and report their verdicts, SHAs, and worktree locations.

## Append telemetry and report

After every run, append exactly one JSON line to `${dataDir}/fleet-log.jsonl`:

```json
{"ts":"<ISO-8601>","repo":"<canonical-repo-key>","taskIds":["<id>"],"verdicts":{},"approvedBranches":["codex/<id>"],"subagentTokens":123}
```

Take `subagentTokens` only from the workflow-completion usage report (`subagent_tokens` in the task notification), not from the engine return value. Omit the field when that figure is unavailable; never estimate it. Append the telemetry even when integration is skipped or aborts.

End with one overview line per worker showing task ID, driver status, review verdict, commands run, files patched, session ID, and a clickable transcript path. Then report the chosen mode, integrated branches, parked branches and reasons, verification outcomes, remaining worktrees/branches, and the telemetry path. If a driver report was lost, label any fields recovered from git state.
