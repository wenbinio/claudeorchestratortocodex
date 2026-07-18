export const meta = {
  name: 'codex-fleet',
  description: 'Fan a coding task list out to parallel Codex CLI (gpt-5.6-sol) workers in isolated git worktrees; verify, correct once, review each diff',
  whenToUse: 'When the user wants Codex/GPT-5.6-Sol to execute a batch of coding tasks under Claude orchestration. args: { repo, tasks: [{id, spec, verify?}], verify?, codexTimeoutMin? }',
  phases: [
    { title: 'Dispatch', detail: 'one Claude driver per task: worktree + codex exec + verify + 1 correction round + commit' },
    { title: 'Review', detail: 'adversarial diff review of each branch against its task spec' },
  ],
}

// ---- args ----------------------------------------------------------------
// repo:            absolute path to a GIT repo (required)
// tasks:           [{ id: 'kebab-id', spec: 'full task spec text', verify?: 'per-task verify command' }]
// verify:          default verify command run in the worktree (e.g. pytest, gdlint+smoke chain)
// codexTimeoutMin: minutes per codex exec call (default 15)

const CODEX = 'C:\\\\Users\\\\<user>\\AppData\\Local\\OpenAI\\Codex\\bin\\5dee10576ec7a5b8\\codex.exe'

// args may arrive as a JSON-encoded string depending on the caller â€” normalize.
let cfg = args
if (typeof cfg === 'string') {
  try { cfg = JSON.parse(cfg) } catch (e) { throw new Error('codex-fleet: args was a string and not valid JSON: ' + e.message) }
}
if (!cfg || !cfg.repo || !Array.isArray(cfg.tasks) || cfg.tasks.length === 0) {
  throw new Error('codex-fleet needs args: { repo: "C:\\\\path\\\\to\\\\git\\\\repo", tasks: [{id, spec}], verify? }')
}
const repo = cfg.repo
const defaultVerify = cfg.verify || ''
const timeoutMs = Math.min((cfg.codexTimeoutMin || 15) * 60000, 600000)
const wtBase = repo.replace(/[\\\/]+$/, '') + '-codex-wt'

const DRIVER_SCHEMA = {
  type: 'object',
  required: ['taskId', 'status', 'branch', 'verifyPassed', 'summary'],
  properties: {
    taskId: { type: 'string' },
    status: { type: 'string', enum: ['done', 'failed', 'blocked'] },
    branch: { type: 'string', description: 'codex/<taskId>, or "" if blocked before branching' },
    worktree: { type: 'string' },
    verifyPassed: { type: 'boolean' },
    correctionRoundUsed: { type: 'boolean' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    diffStat: { type: 'string' },
    verifyTail: { type: 'string', description: 'last ~30 lines of the final verify run' },
    codexFinalMessage: { type: 'string', description: 'Codex final message, trimmed to ~1500 chars' },
    summary: { type: 'string', description: '2-4 sentences: what Codex did, verify outcome, anything off-spec' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['taskId', 'verdict', 'issues'],
  properties: {
    taskId: { type: 'string' },
    verdict: { type: 'string', enum: ['approve', 'needs_work', 'reject'] },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'summary'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          file: { type: 'string' },
          summary: { type: 'string' },
        },
      },
    },
    notes: { type: 'string' },
  },
}

function driverPrompt(task) {
  const verify = task.verify || defaultVerify
  return `You are a Codex worker DRIVER. Codex CLI does the coding; you only orchestrate, verify, and commit. Do NOT write or edit any project source file yourself under any circumstances â€” if Codex's output is wrong after the correction round, report status "failed" and describe why. Communication discipline: your final output is the StructuredOutput call only.

Repo: ${repo}
Task id: ${task.id}
Worktree parent dir: ${wtBase}
Codex binary: ${CODEX}

TASK SPEC (pass to Codex verbatim, plus the constraints noted below):
---
${task.spec}
---

STEPS:

1. Preflight: run "git -C \\"${repo}\\" rev-parse --is-inside-work-tree". If it fails, return status "blocked" with the error in summary. Ensure the worktree parent dir exists (New-Item -ItemType Directory -Force).

2. Create isolated worktree (retry up to 3 times with 2s sleep if git reports a lock, since sibling drivers run concurrently):
   git -C "${repo}" worktree add -b codex/${task.id} "${wtBase}\\${task.id}" HEAD
   If the branch already exists from a previous run, delete it first: git -C "${repo}" worktree remove --force "${wtBase}\\${task.id}"; git -C "${repo}" branch -D codex/${task.id}

3. Dispatch Codex headlessly. CRITICAL: prefix the call with "$null | " â€” codex exec blocks forever on piped stdin otherwise ("Reading additional input from stdin..."). Build the prompt as a single-quoted here-string so nothing interpolates:
   $null | & '${CODEX}' exec <PROMPT> -C "${wtBase}\\${task.id}" -s workspace-write -o "${wtBase}\\${task.id}.codex-last.txt"
   (Note: the -o capture file lives NEXT TO the worktree dir, not inside it, so it can never be committed.)
   The <PROMPT> is the task spec above plus these appended constraints: "Work only inside this directory. Do not run git commands; do not commit. Do not create documentation files unless the spec asks. When done, summarize what you changed and why."
   Run this via the PowerShell tool with run_in_background: true â€” xhigh reasoning can exceed foreground timeouts. You will be notified when it exits; then read ${wtBase}\\${task.id}.codex-last.txt. If the file is absent after exit, treat the dispatch as failed and include the tail of the command output in your summary. Budget guidance: a healthy run finishes well inside ${Math.round(timeoutMs / 60000)} min.

4. Inspect: read ${wtBase}\\${task.id}.codex-last.txt; run git -C "${wtBase}\\${task.id}" diff --stat and git status --short. If Codex changed nothing, return status "failed".

5. Verify${verify ? ` by running, from inside the worktree:\n   ${verify}` : ': no verify command configured â€” skip, set verifyPassed true, and note this in summary.'}

6. If verify FAILED: exactly ONE correction round. Re-run codex exec (same "$null |" + background pattern) in the same worktree with a prompt of: the original spec, then "A verification run failed. Fix the failure without breaking the rest of the task. Failure output:" plus the last ~60 lines of verify output. Then re-verify. If it fails again, still commit (so the reviewer can see the attempt) but set verifyPassed false and status "failed".

7. Commit (you, not Codex). FIRST clean build artifacts the verify run generated: delete every __pycache__ dir, .pytest_cache, .import cache dirs, and any editor/tool droppings inside the worktree that existed in neither HEAD nor the spec (Get-ChildItem -Recurse -Directory -Filter __pycache__ | Remove-Item -Recurse -Force). THEN: git -C "${wtBase}\\${task.id}" add -A && git -C "${wtBase}\\${task.id}" commit -m "codex/${task.id}: <one-line summary of the change>". The commit must contain ONLY files the spec called for â€” check git show --stat afterward and amend-remove anything stray. Never remove the worktree or touch the repo's main branch.

8. Return StructuredOutput per the schema. diffStat = output of git diff --stat HEAD~1 after committing. filesChanged = changed file paths. Trim long outputs to the sizes the schema notes.`
}

function reviewPrompt(task, d) {
  return `Adversarial code review of a Codex-authored change. You have read-only intent: do not edit anything.

Repo: ${repo}
Branch: ${d.branch} (worktree at ${d.worktree})
Task id: ${task.id}
Driver report: verifyPassed=${d.verifyPassed}, correctionRoundUsed=${d.correctionRoundUsed}, status=${d.status}

ORIGINAL SPEC the change must satisfy:
---
${task.spec}
---

Review the actual diff: git -C "${repo}" diff HEAD..codex/${task.id} (read full contents of changed files where the diff alone is ambiguous). Judge:
1. Does the diff actually satisfy the spec â€” fully, not approximately? Missing pieces are blockers.
2. Correctness bugs: concrete inputs/state that produce wrong behavior.
3. Scope creep: files or behavior changed that the spec did not ask for.
4. Convention violations vs the surrounding code (match the repo's existing style, typing, patterns).
Be skeptical of the driver's own summary; trust only the diff. verdict "approve" only if there are no blocker or major issues. Return StructuredOutput per the schema.`
}

phase('Dispatch')
log(`codex-fleet: ${cfg.tasks.length} task(s) against ${repo}`)

const results = await pipeline(
  cfg.tasks,
  t => agent(driverPrompt(t), { label: `codex:${t.id}`, phase: 'Dispatch', schema: DRIVER_SCHEMA }),
  (d, t) => {
    if (!d) return { taskId: t.id, driver: null, review: null }
    if (d.status === 'blocked' || !d.branch) return { taskId: t.id, driver: d, review: null }
    return agent(reviewPrompt(t, d), { label: `review:${t.id}`, phase: 'Review', schema: REVIEW_SCHEMA })
      .then(r => ({ taskId: t.id, driver: d, review: r }))
  }
)

const out = results.filter(Boolean)
const approved = out.filter(r => r.driver && r.driver.verifyPassed && r.review && r.review.verdict === 'approve')
log(`codex-fleet done: ${approved.length}/${out.length} approved. Branches await manual merge â€” merge one at a time, run the full verify pipeline after each, then "git worktree remove" each worktree under ${wtBase} and delete merged codex/* branches.`)

return {
  repo,
  worktreeBase: wtBase,
  results: out,
  approvedBranches: approved.map(r => r.driver.branch),
  mergeInstructions: 'Merge sequentially: git merge codex/<id>; run full verification after EACH merge; on conflict or failure, fix or drop that branch before the next. Then clean worktrees + branches.',
}
