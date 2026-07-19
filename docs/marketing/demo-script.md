# Demo script — install → dispatch → staged diff → merge-guard block

A short scripted walkthrough suitable to record as an asciinema cast or GIF. It shows the four beats that make Codex Fleet distinctive: **install**, **a small dispatch**, **the verified diff landing in your tree**, and **the merge guard blocking an unapproved merge**.

The lines are illustrative. Output is representative of a real run, lightly trimmed for a recording — don't treat token counts, SHAs, or timings as fixed. Slash commands (`/plugin …`, `/codex-fleet:…`) run inside Claude Code; shell commands (`git …`) run in your terminal.

Recording tips: a ~90-second cast is plenty. Type at a human pace, pause ~1s after each command, and let the "PARKED / INTEGRATED" summary and the guard BLOCK message sit on screen for a beat — those are the payoff frames.

---

## Beat 1 — Install & setup (≈15s)

```text
$ # In Claude Code:
> /plugin marketplace add wenbinio/claudeorchestratortocodex
  ✓ Marketplace 'wenbinio' added

> /plugin install codex-fleet@wenbinio
  ✓ Installed codex-fleet@wenbinio (v0.3.0) — 2 skills, 2 agents, 1 hook

> /codex-fleet:setup
  • platform: windows
  • codex CLI: discovered (from ~/.codex/config.toml)
  • auth: subscription  (READY smoke passed)
  • runner backend: app-server  (Node v20.11 · probe OK)
  ✓ Wrote config.json to the plugin data directory
```

**Narration:** "Two commands to install, one to set up. Setup finds your Codex CLI, checks that headless auth works, probes the runner backend, and writes machine-local config — nothing sensitive touches the repo."

---

## Beat 2 — Dispatch a small batch (≈35s)

```text
> /codex-fleet:dispatch
  Add input validation to parse_config() and a matching test.

Claude:
  Planning 2 grounded, single-concern tasks against the current code…
    • task add-validation   → src/config.py  (anchor: parse_config, line 42)
    • task add-vtest        → tests/test_config.py  (new test)
  Dispatching Codex workers (app-server, gpt-5.6-sol @ xhigh)…

  [worker add-validation]  worktree codex/add-validation
    codex: patched src/config.py (+18 −2)
    driver verify: pytest -q  →  PASS  (12 passed)
  [worker add-vtest]       worktree codex/add-vtest
    codex: patched tests/test_config.py (+21)
    driver verify: pytest -q  →  FAIL  (1 failed) → 1 correction round
    codex: patched tests/test_config.py (+3 −1)
    driver verify: pytest -q  →  PASS  (13 passed)

  Adversarial review (independent re-run of verify):
    • add-validation  reviewer verify PASS · scope OK          → approve
    • add-vtest       reviewer verify PASS · scope OK          → approve
```

**Narration:** "I describe the work in one sentence. Claude writes surgical task specs anchored to real code, then dispatches Codex workers — each in its own git worktree. The driver verifies *outside* Codex's sandbox. One worker's tests failed, so it got a single correction round. Then a *separate* adversarial reviewer re-runs the verification itself — the model never certifies its own work."

---

## Beat 3 — The verified diff lands in your tree (≈20s)

```text
  Integrating (stage mode)…
    fleet-stage: add-validation   → full verify PASS
    fleet-stage: add-vtest        → full verify PASS
    reset --soft → one staged diff

  ── Run summary ─────────────────────────────
   INTEGRATED  codex/add-validation   approve
   INTEGRATED  codex/add-vtest        approve
   transcripts: <data-dir>/transcripts/<run>/
  ────────────────────────────────────────────

$ git status
On branch main
Changes to be committed:
  modified:   src/config.py
  modified:   tests/test_config.py

$ git log --oneline -1
9a3f1c2 (HEAD -> main)  chore: last real commit    # ← no fleet commits added
```

**Narration:** "Only approved branches integrate. The stage ladder applies them one at a time, re-verifying after each, and collapses the result into a single staged diff — no fleet commits in your history. It looks exactly like a native Claude Code edit: I review `git diff` and commit when I'm ready."

---

## Beat 4 — The merge guard blocks an unapproved merge (≈20s)

```text
$ # Say a branch was NOT approved (reviewer said reject),
$ # or its tip changed after review. Ask Claude to merge it:

> merge codex/experimental-refactor into main

Claude runs:  git merge --squash codex/experimental-refactor

  ⛔ codex-fleet merge guard: BLOCKED
     branch codex/experimental-refactor has no 'approve' verdict
     recorded for its current tip SHA (7b2e9f1).
     This gate covers Claude's tool calls only — your own
     terminal is unaffected. To proceed: apply the reviewer's
     fixes and re-run /codex-fleet:dispatch, or merge it
     yourself from your terminal.
```

**Narration:** "And the seatbelt: if Claude tries to merge a `codex/*` branch that wasn't approved for its exact commit, the SHA-keyed guard blocks it. It's advisory — it only gates Claude's own tools, never your terminal — but it means unreviewed model output can't sneak in through the assistant."

---

## Closing frame (optional, ≈5s)

```text
Claude plans + reviews.  Codex writes.  Nothing lands unverified.

  github.com/wenbinio/claudeorchestratortocodex   (MIT)
```

---

## Asciinema / GIF production notes

- Record with `asciinema rec demo.cast`, then convert to GIF with `agg demo.cast demo.gif` (or use a terminal-to-GIF tool of choice).
- If the real dispatch is too slow or too chatty for a clean recording, record the four beats separately and stitch them, or hand-drive a scripted terminal that echoes these lines — the flow above is faithful to real output.
- Keep a dark terminal theme; the PARKED/INTEGRATED summary and the guard BLOCK are the two "money" frames — give them extra dwell time.
- Target 30–90 seconds total. For a static README embed, the Beat 3 summary + Beat 4 block make a strong single screenshot.
