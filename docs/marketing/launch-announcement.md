# Launch announcement drafts

These are **drafts for the repo owner to review and post manually.** Nothing here has been submitted anywhere. Repo: https://github.com/wenbinio/claudeorchestratortocodex

Tone target: honest, concrete, no hype. Every claim below is traceable to the design spec and shipped code. The scasella credit appears in each channel because the app-server transport is vendored from that project.

---

## 1. Show HN

**Title (pick one):**

- `Show HN: Codex Fleet – Claude reviews and gates the code Codex writes into your repo`
- `Show HN: Treat LLM-generated code as an untrusted supply chain (Claude Code plugin)`

**Body:**

Codex Fleet is a Claude Code plugin that lets Claude orchestrate OpenAI Codex (`gpt-5.6-sol`) workers to write code — but with an adversarial gate between the model's output and your repo.

The idea: don't trust a word the model writes. You describe the work, Claude drafts grounded single-concern task specs, and each Codex worker runs in its own isolated git worktree. Then:

- The Claude driver runs your verification command *outside* Codex's sandbox (Codex can't reliably run local toolchains, so it never self-certifies).
- A separate adversarial reviewer re-runs that verification independently and returns approve / needs_work / reject. It trusts only the diff and rejects scope creep.
- Only `approve`-verdict branches integrate. The default `stage` mode applies them via a temp-commit ladder, verifies after each, parks anything that goes red, and collapses the rest into one staged, uncommitted diff in your working tree — so it lands like a native Claude Code edit, with no fleet commits in your history. You inspect `git diff` and commit when ready.
- A SHA-keyed merge-guard hook blocks Claude-tool merges of `codex/*` branches whose tip has no recorded approval. It's an advisory seatbelt (it doesn't touch your own terminal), not a security boundary — the dispatch protocol is the real enforcement.

v0.3 unifies everything onto one runner-first lifecycle with two backends: app-server (sessionful Codex threads over `codex app-server` JSON-RPC, when Node ≥ 18 and a capability probe passes) and `codex exec` otherwise. There's a hermetic mock-app-server test suite so `npm test` runs with no real Codex, plus CI on Ubuntu and Windows. With no Codex auth at all, it falls back to Claude subagents running the identical pipeline.

Honest positioning: the closest project is scasella/claude-dynamic-workflows-codex (MIT, © Stephen Casella) — Codex Fleet vendors its app-server transport verbatim, attribution preserved in `vendor/`. But that project is a general workflow-DSL runtime for research/triage/brainstorm fleets over a Codex backend; Codex Fleet is a git-native code-*delivery* pipeline: isolated worktrees, mandatory independent verification, adversarial review, SHA-keyed merge gating, stage-ladder integration.

Also honest about what's untested at release: the POSIX driver path, a second Windows machine, and the cloud sandbox surface (including cloud guard behavior). Those first real runs are the validation. It's single-provider (Codex only) today.

Repo (MIT): https://github.com/wenbinio/claudeorchestratortocodex

Happy to answer questions about the stage ladder, the merge-guard design, or why the reviewer re-runs verification instead of trusting the driver.

---

## 2. r/ClaudeAI

**Title:** `I built a Claude Code plugin that treats Codex's output as untrusted — adversarial review + merge gating before anything lands`

**Body:**

Sharing an open-source Claude Code plugin I've been building: **Codex Fleet**.

The premise is simple. If you let an LLM write code into your repo, you shouldn't trust its own "looks good to me." So Codex Fleet puts a gate in the way.

**The flow:**
1. You describe the work. Claude writes grounded, single-concern task specs (with real file/line anchors, explicit "don't touch X" exclusions).
2. Codex (`gpt-5.6-sol`) workers write the code — in parallel, each in its own isolated git worktree.
3. The Claude driver runs your verify command **outside** Codex's sandbox.
4. A **separate adversarial reviewer** re-runs verification independently and votes approve / needs_work / reject. It only trusts the diff.
5. Only approved branches integrate. Default mode stages them, verifies after each, parks whatever fails, and leaves you one clean staged diff — no fleet commits in your history. You commit when you're happy.
6. A SHA-keyed merge-guard hook blocks Claude from merging any `codex/*` branch that hasn't been approved for that exact commit. (It's advisory — it only gates Claude's tools, never your terminal.)

**What's in v0.3:** one unified runner-first lifecycle, two backends (sessionful app-server over JSON-RPC when you have Node ≥ 18, `codex exec` otherwise), a hermetic mock test suite (`npm test`, no real Codex needed), and CI on Ubuntu + Windows. No Codex auth? It falls back to Claude subagents running the same pipeline.

**Credit where due:** the app-server transport is vendored verbatim from [scasella/claude-dynamic-workflows-codex](https://github.com/scasella/claude-dynamic-workflows-codex) (MIT, © Stephen Casella). That project is a general workflow runtime for Codex fleets; this one is specifically a git-native code-delivery pipeline with the review/gating machinery on top.

**Being upfront:** the POSIX path, a second Windows machine, and the cloud sandbox surface are untested by a real run at release — those first runs are the test. Single-provider (Codex) for now.

Install is three commands (`/plugin marketplace add …`, `/plugin install …`, `/codex-fleet:setup`). Repo + README: https://github.com/wenbinio/claudeorchestratortocodex

Feedback welcome — especially from anyone who's tried multi-agent codegen and hit the "the model said it passed but it didn't" problem.

---

## 3. X / Twitter thread

**1/**
Codex Fleet: a Claude Code plugin that treats LLM-generated code as an untrusted supply chain.

Claude plans + reviews. Codex writes. Nothing lands until an adversarial reviewer independently re-runs your tests and passes it.

Open source (MIT) 🧵
https://github.com/wenbinio/claudeorchestratortocodex

**2/**
The problem with "let the model write code into my repo": the model grades its own homework.

Codex Fleet puts a gate in the way. Codex writes in an isolated git worktree. Claude verifies OUTSIDE Codex's sandbox. A separate reviewer re-runs the tests and can reject.

**3/**
Only approved branches integrate.

Default mode: apply in verdict order, verify after each, park anything that goes red, and collapse the rest into ONE staged diff in your working tree.

No fleet commits in your history. You inspect `git diff` and commit when ready.

**4/**
There's also a SHA-keyed merge-guard hook: it blocks Claude from merging any `codex/*` branch whose exact tip hasn't been approved.

It's an advisory seatbelt — gates Claude's tools only, never your own terminal. The dispatch protocol is the real enforcement.

**5/**
v0.3 runs on one unified runner-first lifecycle:
• app-server backend (sessionful Codex threads over JSON-RPC, Node ≥ 18)
• `codex exec` otherwise
• hermetic mock test suite — `npm test`, no real Codex needed
• CI on Ubuntu + Windows
No Codex auth? Claude subagents run the same pipeline.

**6/**
Credit: the app-server transport is vendored verbatim from @/scasella's claude-dynamic-workflows-codex (MIT). Attribution preserved in `vendor/`.

Theirs is a general workflow runtime for Codex fleets. Codex Fleet is specifically a git-native code-*delivery* pipeline.

**7/**
Honest about the edges: the POSIX path, a second Windows machine, and the cloud sandbox surface are untested by a real run at release. Single-provider (Codex) for now.

Three commands to install. Repo, README, and design spec here 👇
https://github.com/wenbinio/claudeorchestratortocodex
