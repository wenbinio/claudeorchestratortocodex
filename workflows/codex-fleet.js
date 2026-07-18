export const meta = {
  name: 'codex-fleet',
  description: 'Fan coding tasks out to isolated Codex CLI or Claude workers, verify and correct once, commit, and adversarially review each branch',
  whenToUse: 'When a batch of coding tasks should run in parallel worktrees. args: { repo, tasks: [{id, spec, verify?}], verify?, mode?, codexExe?, platform, transcriptDir?, agentTypes? }',
  phases: [
    { title: 'Dispatch', detail: 'one driver per task: worktree + implementation + verify + one correction round + commit' },
    { title: 'Review', detail: 'adversarial diff review with an independent verification run for each branch' },
  ],
}

// args may arrive as a JSON-encoded string depending on the caller.
let cfg = args
if (typeof cfg === 'string') {
  try {
    cfg = JSON.parse(cfg)
  } catch (e) {
    throw new Error('codex-fleet: args was a string and not valid JSON: ' + e.message)
  }
}

if (!cfg || !cfg.repo || !Array.isArray(cfg.tasks) || cfg.tasks.length === 0) {
  throw new Error('codex-fleet needs args: { repo, platform: "windows"|"posix", tasks: [{id, spec}], verify? }')
}

const mode = cfg.mode || 'codex'
if (mode !== 'codex' && mode !== 'claude') {
  throw new Error('codex-fleet: cfg.mode must be "codex" or "claude"')
}

const platform = cfg.platform
if (platform !== 'windows' && platform !== 'posix') {
  throw new Error('codex-fleet: cfg.platform must be "windows" or "posix"; run /codex-fleet:setup first')
}

if (mode === 'codex' && (typeof cfg.codexExe !== 'string' || !cfg.codexExe.trim())) {
  throw new Error('codex-fleet: cfg.codexExe is required in codex mode; run /codex-fleet:setup first')
}

const repo = String(cfg.repo)
const repoBase = repo.replace(/[\\/]+$/, '')
const defaultVerify = cfg.verify || ''
const codexExe = mode === 'codex' ? cfg.codexExe : ''
const pathSeparator = platform === 'windows' ? '\\' : '/'
const wtBase = repoBase + '-codex-wt'
const transcriptBase = cfg.transcriptDir
  ? String(cfg.transcriptDir).replace(/[\\/]+$/, '')
  : wtBase
const CODEX_TOOL_TIMEOUT_MS = 600000

function joinPath(parent, child) {
  return String(parent).replace(/[\\/]+$/, '') + pathSeparator + String(child).replace(/^[\\/]+/, '')
}

function taskPaths(task) {
  return {
    worktree: joinPath(wtBase, task.id),
    capture: joinPath(wtBase, task.id + '.codex-last.txt'),
    events: joinPath(wtBase, task.id + '.codex-events.jsonl'),
    transcript: joinPath(transcriptBase, task.id + '.transcript.md'),
  }
}

function powerShellQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

function posixQuote(value) {
  return "'" + String(value).replace(/'/g, "'\"'\"'") + "'"
}

const DRIVER_SCHEMA = {
  type: 'object',
  required: ['taskId', 'status', 'branch', 'verifyPassed', 'summary'],
  properties: {
    taskId: { type: 'string' },
    status: { type: 'string', enum: ['done', 'failed', 'blocked'] },
    branch: { type: 'string', description: 'codex/<taskId>, or "" only when blocked before branching' },
    worktree: { type: 'string' },
    verifyPassed: { type: 'boolean' },
    correctionRoundUsed: { type: 'boolean' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    diffStat: { type: 'string' },
    verifyTail: { type: 'string', description: 'last approximately 30 lines of the final verify run' },
    codexFinalMessage: { type: 'string', description: 'Codex final message, trimmed to approximately 1500 characters' },
    codexCommandsRun: { type: 'integer', default: 0 },
    filesPatched: { type: 'array', items: { type: 'string' }, default: [] },
    sessionId: { type: 'string', default: '' },
    transcriptPath: { type: 'string', default: '' },
    summary: { type: 'string', description: '2-4 sentences: implementation, verification outcome, and anything off-spec' },
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
    verifyPassed: { type: 'boolean', default: false },
    verifyTail: { type: 'string' },
    notes: { type: 'string' },
  },
}

function windowsCommandBlock(task, paths) {
  const qRepo = powerShellQuote(repo)
  const qWtBase = powerShellQuote(wtBase)
  const qWorktree = powerShellQuote(paths.worktree)
  const qCapture = powerShellQuote(paths.capture)
  const qEvents = powerShellQuote(paths.events)
  const qTranscriptBase = powerShellQuote(transcriptBase)
  const qTranscript = powerShellQuote(paths.transcript)
  const qBranch = powerShellQuote('codex/' + task.id)

  let codexCommands = ''
  if (mode === 'codex') {
    const qCodex = powerShellQuote(codexExe)
    codexCommands = `
CODEX INITIAL EXECUTION (the event file was cleared during preparation):
  $codexPrompt = @'
  <the exact prompt described in the implementation step>
  '@
  $null | & ${qCodex} exec --json $codexPrompt -C ${qWorktree} -s workspace-write -o ${qCapture} | Tee-Object -FilePath ${qEvents}

CODEX CORRECTION EXECUTION (a new session; append its events):
  $correctionPrompt = @'
  <the exact correction prompt described in the correction step>
  '@
  $null | & ${qCodex} exec --json $correctionPrompt -C ${qWorktree} -s workspace-write -o ${qCapture} | Tee-Object -FilePath ${qEvents} -Append

CODEX TIMEOUT CONTINUATION (append to the same event file):
  $null | & ${qCodex} exec resume $sessionId 'continue' --json -o ${qCapture} | Tee-Object -FilePath ${qEvents} -Append

Every Codex command above is a FOREGROUND shell-tool call with timeout: ${CODEX_TOOL_TIMEOUT_MS}. Never set run_in_background and never launch Codex via Start-Process. If a call times out, kill only the Codex process belonging to this task before resuming. Use its process id when available:
  Stop-Process -Id <timed-out-codex-pid> -Force
If a pid is not reported, locate the process by BOTH the Codex executable and this exact worktree/session command line before Stop-Process; never kill sibling fleet workers.

TRANSCRIPT WRITE (outside the worktree unless the caller explicitly configured another directory):
  [System.IO.File]::WriteAllText(${qTranscript}, $transcriptMarkdown, [System.Text.UTF8Encoding]::new($false))`
  }

  return `WINDOWS / POWERSHELL COMMAND BLOCK
Use these Windows-native commands and these already backslash-joined paths. Check every native command's $LASTEXITCODE.

PREFLIGHT AND DIRECTORIES:
  & git -C ${qRepo} rev-parse --is-inside-work-tree
  New-Item -ItemType Directory -Force -Path ${qWtBase} | Out-Null
  New-Item -ItemType Directory -Force -Path ${qTranscriptBase} | Out-Null

REMOVE A STALE TASK WORKTREE/BRANCH, IF PRESENT:
  & git -C ${qRepo} worktree remove --force ${qWorktree} 2>$null
  & git -C ${qRepo} show-ref --verify --quiet ('refs/heads/' + ${qBranch})
  if ($LASTEXITCODE -eq 0) { & git -C ${qRepo} branch -D ${qBranch} }

CREATE THE WORKTREE, RETRYING LOCK ERRORS AT MOST THREE TIMES:
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    & git -C ${qRepo} worktree add -b ${qBranch} ${qWorktree} HEAD
    if ($LASTEXITCODE -eq 0) { break }
    if ($attempt -eq 3) { throw 'worktree add failed after three attempts' }
    Start-Sleep -Seconds 2
  }

CLEAR STALE OUT-OF-WORKTREE CODEX FILES:
  Remove-Item -LiteralPath ${qCapture}, ${qEvents} -Force -ErrorAction SilentlyContinue

INSPECT:
  & git -C ${qWorktree} diff --stat
  & git -C ${qWorktree} status --short

PURGE GENERATED CACHE ARTIFACTS BEFORE STAGING:
  Get-ChildItem -LiteralPath ${qWorktree} -Recurse -Force -Directory |
    Where-Object { $_.Name -in @('__pycache__', '.pytest_cache', '.import') } |
    Remove-Item -Recurse -Force
Inspect git status and Remove-Item only other untracked editor/tool droppings that were in neither HEAD nor the task spec.

COMMIT AND AUDIT:
  & git -C ${qWorktree} add -A
  & git -C ${qWorktree} commit -m ${powerShellQuote('codex/' + task.id + ': <one-line summary>')}
  & git -C ${qWorktree} show --stat --oneline HEAD
  & git -C ${qWorktree} show --name-only --format= HEAD
  & git -C ${qWorktree} diff --stat HEAD~1
${codexCommands}`
}

function posixCommandBlock(task, paths) {
  const qRepo = posixQuote(repo)
  const qWtBase = posixQuote(wtBase)
  const qWorktree = posixQuote(paths.worktree)
  const qCapture = posixQuote(paths.capture)
  const qEvents = posixQuote(paths.events)
  const qTranscriptBase = posixQuote(transcriptBase)
  const qTranscript = posixQuote(paths.transcript)
  const qBranch = posixQuote('codex/' + task.id)
  const qBranchRef = posixQuote('refs/heads/codex/' + task.id)

  let codexCommands = ''
  if (mode === 'codex') {
    const qCodex = posixQuote(codexExe)
    codexCommands = `
CODEX INITIAL EXECUTION (the event file was cleared during preparation):
  codex_prompt=$(cat <<'CODEX_FLEET_PROMPT'
  <the exact prompt described in the implementation step>
  CODEX_FLEET_PROMPT
  )
  set -o pipefail
  ${qCodex} exec --json "$codex_prompt" -C ${qWorktree} -s workspace-write -o ${qCapture} < /dev/null | tee ${qEvents}

CODEX CORRECTION EXECUTION (a new session; append its events):
  correction_prompt=$(cat <<'CODEX_FLEET_CORRECTION'
  <the exact correction prompt described in the correction step>
  CODEX_FLEET_CORRECTION
  )
  ${qCodex} exec --json "$correction_prompt" -C ${qWorktree} -s workspace-write -o ${qCapture} < /dev/null | tee -a ${qEvents}

CODEX TIMEOUT CONTINUATION (append to the same event file):
  ${qCodex} exec resume "$session_id" 'continue' --json -o ${qCapture} < /dev/null | tee -a ${qEvents}

Every Codex command above is a FOREGROUND shell-tool call with timeout: ${CODEX_TOOL_TIMEOUT_MS}. Never set run_in_background and never append '&'. If a call times out, kill only the Codex process belonging to this task before resuming. Use its process id when available:
  kill -TERM <timed-out-codex-pid>
  kill -KILL <timed-out-codex-pid>  # only if it survives TERM
If a pid is not reported, locate the process by BOTH the Codex executable and this exact worktree/session command line; never use a broad pkill that could kill sibling fleet workers.

TRANSCRIPT WRITE (outside the worktree unless the caller explicitly configured another directory):
  printf '%s\n' "$transcript_markdown" > ${qTranscript}`
  }

  return `POSIX / SHELL COMMAND BLOCK
Use these POSIX-native commands and these already slash-joined paths. Check every command's exit status; keep pipefail enabled around tee pipelines.

PREFLIGHT AND DIRECTORIES:
  git -C ${qRepo} rev-parse --is-inside-work-tree
  mkdir -p -- ${qWtBase}
  mkdir -p -- ${qTranscriptBase}

REMOVE A STALE TASK WORKTREE/BRANCH, IF PRESENT:
  git -C ${qRepo} worktree remove --force ${qWorktree} 2>/dev/null || true
  if git -C ${qRepo} show-ref --verify --quiet ${qBranchRef}; then git -C ${qRepo} branch -D ${qBranch}; fi

CREATE THE WORKTREE, RETRYING LOCK ERRORS AT MOST THREE TIMES:
  attempt=1
  until git -C ${qRepo} worktree add -b ${qBranch} ${qWorktree} HEAD; do
    if [ "$attempt" -ge 3 ]; then echo 'worktree add failed after three attempts' >&2; exit 1; fi
    attempt=$((attempt + 1))
    sleep 2
  done

CLEAR STALE OUT-OF-WORKTREE CODEX FILES:
  rm -f -- ${qCapture} ${qEvents}

INSPECT:
  git -C ${qWorktree} diff --stat
  git -C ${qWorktree} status --short

PURGE GENERATED CACHE ARTIFACTS BEFORE STAGING:
  find ${qWorktree} -type d \\( -name '__pycache__' -o -name '.pytest_cache' -o -name '.import' \\) -prune -exec rm -rf -- {} +
Inspect git status and rm only other untracked editor/tool droppings that were in neither HEAD nor the task spec.

COMMIT AND AUDIT:
  git -C ${qWorktree} add -A
  git -C ${qWorktree} commit -m ${posixQuote('codex/' + task.id + ': <one-line summary>')}
  git -C ${qWorktree} show --stat --oneline HEAD
  git -C ${qWorktree} show --name-only --format= HEAD
  git -C ${qWorktree} diff --stat HEAD~1
${codexCommands}`
}

function codexImplementationBlock(task, paths) {
  return `3. IMPLEMENT BY CODEX. You orchestrate only. You MUST NOT write, patch, or edit any project source file yourself. Codex does the coding; you may only create the out-of-worktree event/capture/transcript files, run lifecycle commands, verify, and commit.

Build the Codex prompt from the TASK SPEC verbatim and append exactly these constraints:
"Work only inside this directory. Do not run git commands; do not commit. Do not create documentation files unless the spec asks. When done, summarize what you changed and why."

Run CODEX INITIAL EXECUTION from the platform block. It MUST include --json, tee stdout as JSONL to ${paths.events}, write the final-message capture with -o to ${paths.capture}, close stdin with the platform's shown idiom, and stay in the foreground with shell-tool timeout ${CODEX_TOOL_TIMEOUT_MS}. The -o and JSONL files are beside the worktree, never inside it. run_in_background is explicitly forbidden.

TIMEOUT POLICY FOR EVERY CODEX EXEC INVOCATION: if the foreground tool reaches ${CODEX_TOOL_TIMEOUT_MS} ms, kill its process first. Read sessionId from the JSONL events file (normally the early session/thread-start event; accept the actual session_id, sessionId, thread_id, or equivalent field emitted by Codex). Then run exactly ONE CODEX TIMEOUT CONTINUATION window using "codex exec resume <sessionId> 'continue'", also foreground with timeout ${CODEX_TOOL_TIMEOUT_MS}, --json, closed stdin, and events appended. If the session id cannot be recovered, resume fails, or that second window times out, stop dispatching and report status "failed" with explicit guidance to decompose this task into smaller tasks. Never open a third window.

After Codex finishes, read ${paths.capture}. If it is absent, treat the dispatch as failed and preserve the best command-output tail in the summary.`
}

function claudeImplementationBlock(paths) {
  return `3. IMPLEMENT BY CLAUDE. Implement the TASK SPEC yourself inside ${paths.worktree}. The Codex-mode no-source-edit rule is lifted: you are the coding worker as well as the lifecycle driver. Keep every project edit inside this worktree, do not create documentation unless the spec asks, and do not commit until the commit step below. Do not create Codex event, capture, or transcript files. Codex-specific StructuredOutput fields may be omitted and will take their schema defaults.`
}

function codexCorrectionBlock(paths) {
  return `6. ONE CORRECTION ROUND MAXIMUM. If verification fails, set correctionRoundUsed true and run one CODEX CORRECTION EXECUTION in the same worktree. Its prompt is the original TASK SPEC plus the same appended constraints, followed by: "A verification run failed. Fix the failure without breaking the rest of the task. Failure output:" and the last approximately 60 lines of verification output. The same foreground, JSONL tee, timeout, kill, single-resume-window, and never-edit-source-yourself rules apply. Re-run verification afterward. If it fails again, do not dispatch a third implementation attempt: continue to the commit step, set verifyPassed false and status "failed".`
}

function claudeCorrectionBlock() {
  return `6. ONE CORRECTION ROUND MAXIMUM. If verification fails, set correctionRoundUsed true and make exactly one corrective edit pass yourself using the last approximately 60 lines of verification output. Re-run verification afterward. If it fails again, do not make a third implementation attempt: continue to the commit step, set verifyPassed false and status "failed".`
}

function driverPrompt(task) {
  const verify = task.verify || defaultVerify
  const paths = taskPaths(task)
  const platformCommands = platform === 'windows'
    ? windowsCommandBlock(task, paths)
    : posixCommandBlock(task, paths)
  const implementation = mode === 'codex'
    ? codexImplementationBlock(task, paths)
    : claudeImplementationBlock(paths)
  const correction = mode === 'codex'
    ? codexCorrectionBlock(paths)
    : claudeCorrectionBlock()
  const verifyStep = verify
    ? `5. VERIFY. From inside the worktree, run this exact command yourself and capture its exit status and output:\n---\n${verify}\n---\nSet verifyPassed true only on exit code 0.`
    : '5. VERIFY. No verify command is configured. Skip execution, set verifyPassed true, and explicitly note the skip in summary.'
  const observability = mode === 'codex'
    ? `
8. DISTILL CODEX OBSERVABILITY even when implementation or verification failed. Parse every valid JSON line in ${paths.events}; tolerate partial/malformed final lines and use best-available data. Write ${paths.transcript} as Markdown with exactly these top-level sections:
   # PROMPT — the original Codex prompt and any correction/continue prompt.
   # TIMELINE — in event order, every command Codex ran with its exit status when present, and every file it patched. Do not invent missing statuses.
   # FINAL MESSAGE — the final captured Codex message, trimmed only in StructuredOutput, not in the transcript.
   # USAGE — input/output/total tokens when emitted, duration when derivable, and sessionId.
Populate codexCommandsRun from command events, filesPatched as unique event-reported paths, sessionId from the event stream, and transcriptPath=${paths.transcript}. Use defaults 0, [], and "" when an event field is unavailable; never fabricate telemetry. If transcript writing itself fails, keep transcriptPath empty and report the failure in summary.`
    : ''

  return `You are a ${mode === 'codex' ? 'Codex worker' : 'Claude fallback'} DRIVER for one fleet task. Follow the shared lifecycle below and use only the platform command block supplied here.

ALWAYS-REPORT RULE: your final action MUST be the StructuredOutput call matching the schema. On any failure, timeout, interruption, or nudge, report status "failed" with every best-available field; never end in prose and never merely say that you are waiting. Use status "blocked" only when preflight proves the repo cannot be used and no task branch could be created.

Mode: ${mode}
Platform: ${platform}
Repo: ${repo}
Task id: ${task.id}
Branch: codex/${task.id}
Worktree parent: ${wtBase}
Worktree: ${paths.worktree}

TASK SPEC:
---
${task.spec}
---

${platformCommands}

SHARED LIFECYCLE:

1. PREFLIGHT. Run the platform block's preflight command. If it fails or the result is not a Git worktree, return StructuredOutput immediately with status "blocked", branch "", verifyPassed false, and the error in summary. Create the worktree and transcript parent directories using the platform commands.

2. ISOLATE. Remove only this task's stale worktree/branch if present, then create branch codex/${task.id} at ${paths.worktree} from HEAD. Retry a Git lock failure up to three total attempts with two seconds between attempts because sibling drivers run concurrently. Never remove any other worktree and never touch the repo's main branch. In codex mode, clear stale capture/events files before dispatch.

${implementation}

4. INSPECT. Run diff --stat and status --short in the worktree. In codex mode, also read the capture file. If implementation changed nothing, report status "failed". Record the actual changed paths rather than trusting an implementation summary.

${verifyStep}

${correction}

7. PURGE, COMMIT, AND AUDIT. Before staging, remove every generated __pycache__, .pytest_cache, and .import cache directory using the platform cleanup command. Inspect status and remove other untracked editor/tool droppings that existed in neither HEAD nor the TASK SPEC. Stage all intended changes and commit once with message "codex/${task.id}: <one-line summary>". Failed-twice changes still commit so the reviewer can inspect them, but status remains "failed". Run git show --stat and git show --name-only afterward; if the commit contains any file outside the spec, remove it from the commit and amend before reporting. Never remove the worktree. diffStat is git diff --stat HEAD~1 and filesChanged is the committed path list; this audit assumes the single task commit created here.
${observability}

9. REPORT. Return StructuredOutput only. Set status "done" only when implementation completed and final verification passed (or was explicitly skipped because none was configured). Trim verifyTail to approximately 30 lines and codexFinalMessage to approximately 1500 characters. The worktree and branch are ground truth, so fill branch/worktree/files/diff fields from Git even if an earlier tool call lost output. On every failure path, obey the always-report rule with best-available fields.`
}

function reviewPrompt(task, driver) {
  const verify = task.verify || defaultVerify
  const independentVerify = verify
    ? `You MUST independently run this exact verification command yourself from the worktree, even if the driver says it passed:\n---\n${verify}\n---\nCapture the exit status and a useful output tail. The driver's run does not count. verdict "approve" is forbidden unless your own run is green.`
    : 'No task verification command was configured. Because you cannot establish your own green run, verdict "approve" is forbidden; use "needs_work" or "reject" and explain this verification gap.'

  return `Adversarial code review of a fleet-authored change. You have read-only intent: do not edit project source, commits, branches, or worktree state. Your final action must be StructuredOutput only.

Repo: ${repo}
Branch: ${driver.branch}
Worktree: ${driver.worktree}
Task id: ${task.id}
Driver report: verifyPassed=${driver.verifyPassed}, correctionRoundUsed=${driver.correctionRoundUsed}, status=${driver.status}

ORIGINAL SPEC the change must satisfy:
---
${task.spec}
---

Review the actual diff with git -C "${repo}" diff HEAD..codex/${task.id}, and read the full contents of changed files where the diff alone is ambiguous. Judge:
1. Whether the diff fully satisfies the spec. Missing pieces are blockers.
2. Correctness bugs with concrete inputs or state that produce wrong behavior.
3. Scope creep: files or behavior changed that the spec did not request.
4. Convention violations against the surrounding code's style, typing, and patterns.

${independentVerify}

Be skeptical of the driver's summary and verification claim; trust the diff and your own verification run. verdict "approve" requires your own green verification run and no blocker or major issue. Return StructuredOutput with verifyPassed reflecting your run, its output tail in verifyTail, and concrete issues.`
}

function agentOptions(role, task) {
  const options = {
    label: `${role === 'driver' ? mode : 'review'}:${task.id}`,
    phase: role === 'driver' ? 'Dispatch' : 'Review',
    schema: role === 'driver' ? DRIVER_SCHEMA : REVIEW_SCHEMA,
  }
  if (cfg.agentTypes && cfg.agentTypes[role] !== undefined) {
    options.agentType = cfg.agentTypes[role]
  }
  return options
}

phase('Dispatch')
log(`codex-fleet: ${cfg.tasks.length} task(s), mode=${mode}, platform=${platform}, repo=${repo}`)

const results = await pipeline(
  cfg.tasks,
  task => agent(driverPrompt(task), agentOptions('driver', task)),
  (driver, task) => {
    if (!driver) return { taskId: task.id, driver: null, review: null }
    if (driver.status === 'blocked' || !driver.branch) {
      return { taskId: task.id, driver, review: null }
    }
    return agent(reviewPrompt(task, driver), agentOptions('reviewer', task))
      .then(review => ({ taskId: task.id, driver, review }))
  }
)

const out = results.filter(Boolean)
const approved = out.filter(result => (
  result.driver &&
  result.driver.verifyPassed &&
  result.review &&
  result.review.verdict === 'approve'
))

log(`codex-fleet done: ${approved.length}/${out.length} approved. Branches await the caller's selected integration flow; apply approved branches sequentially and run the full verification pipeline after each.`)

export default {
  results: out,
  approvedBranches: approved.map(result => result.driver.branch),
  worktreeBase: wtBase,
}
