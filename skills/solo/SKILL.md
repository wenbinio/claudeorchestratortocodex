---
name: solo
description: Use when the user wants to quickly delegate one coding task to Codex without the full fleet ceremony, while retaining verification, review, verdict recording, and staged integration.
---

# Delegate One Task

Run one grounded Codex task through the fleet safety gates without multi-task planning.

## Configure

1. Resolve `dataDir` to `${CLAUDE_PLUGIN_DATA}` when available; otherwise glob `~/.claude/plugins/data/*codex-fleet*/` (the on-disk id may be plugin-name or marketplace-qualified); otherwise use `~/.claude/plugins/data/codex-fleet/`.
2. Read `${dataDir}/config.json`. If missing, stop, run `/codex-fleet:setup`, then re-read it. Never guess paths or authentication. Require absolute existing `codexExe` and `nodeExe`; compare their current versions with `codexVersion` and `nodeVersion`, and re-run setup for stale paths or versions. Use configured `backend`, `model`, and `effort` verbatim.

## Ground one task

Take the user's description as the only task. Inspect the target files and surrounding code. Write one surgical spec with exact file/symbol anchors, one acceptance condition, allowed files, and an explicit `Do not modify: ...` list. Never ask Codex to run tests; the runner verifies outside its sandbox.

Choose the project's known verification command. If none is discoverable, ask the user. If none is supplied, omit `verify`, set `allowUnverified: true`, and clearly warn that the run lacks test evidence and cannot pass the normal approval gate.

## Run the worker

Create `runId = solo-<filesystem-safe-timestamp>`, `outDir = ${dataDir}/runs/${runId}`, and a temporary batch JSON:

```json
{"runId":"solo-<timestamp>","outDir":"<outDir>","repo":"<repo>","codexExe":"<absolute codexExe>","backend":"<backend>","model":"<model>","effort":"<effort>","maxParallel":1,"tasks":[{"id":"solo","spec":"<grounded spec>","verify":"<command>","allowUnverified":false}]}
```

Run **in the background**, using the absolute `nodeExe`:

```text
"<absolute nodeExe>" "${CLAUDE_PLUGIN_ROOT}/runner/fleet-runner.mjs" --batch <temp-batch.json>
```

Act on completion and delete the temporary batch in `finally`. Read `${outDir}/results.json`.

## Review, record, and stage

Continue only when the sole result has `status: "done"` and `verifyPassed: true`. By default spawn exactly one `codex-fleet:fleet-reviewer` agent with the spec, base SHA, branch, worktree, and verify command; require its independent verify and structured verdict.

Before integration, record the current branch tip with exactly one verdict-store command; never hand-write the store:

```text
"<absolute nodeExe>" "${CLAUDE_PLUGIN_ROOT}/scripts/verdict-store.mjs" write --store "${dataDir}/approved.json" --repo "<repo>" --branch "codex/solo" --sha "<current tip>" --review-verdict approve|needs_work|reject --driver-verify-passed true|false --review-verify-passed true|false --allow-unverified false
```

If the helper reports corrupt state or any write failure, do not integrate. Integrate only an `approve` with green reviewer verification.

If the user said `skip review` up front, spawn no reviewer. Record `--review-verdict approve --driver-verify-passed true --review-verify-passed false --allow-unverified true`, then stage with an explicit **UNREVIEWED** warning in the report.

Stage-integrate the single eligible branch. Use `${CLAUDE_PLUGIN_ROOT}/scripts/stage-ladder.mjs` when present; otherwise follow the dispatch skill's `stage` procedure verbatim. Require a clean caller tree and full-project verification; leave the result as one staged, uncommitted diff.

For failed, blocked, unverified, rejected, or verify-red work, report its transcript path, park its branch/worktree, and never integrate it.

Always end with what landed as a staged diff, verification evidence, transcript path, and the `fleet-runner --cleanup` hint: `"<absolute nodeExe>" "${CLAUDE_PLUGIN_ROOT}/runner/fleet-runner.mjs" --cleanup`.
