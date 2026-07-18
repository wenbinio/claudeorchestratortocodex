# Claude Code Plugin Format — Verified Facts

Researched against official docs 2026-07-18. Workers: treat this as authoritative; do not invent fields.

## plugin.json (`.claude-plugin/plugin.json`)

Required: `name` only (kebab-case; becomes the skill namespace prefix `/name:skill`).
Recommended: `description` (discovery), `version` (set it — we version-pin releases), `author`.
Do NOT add a `userConfig` block — this plugin keeps machine config solely in the data-dir `config.json` written by the setup skill.

## marketplace.json (`.claude-plugin/marketplace.json`)

```json
{
  "name": "wenbinio",
  "owner": { "name": "wenbinio" },
  "plugins": [
    {
      "name": "codex-fleet",
      "source": { "source": "github", "repo": "wenbinio/claudeorchestratortocodex" },
      "description": "<one line>"
    }
  ]
}
```

## Install commands (README material)

```
/plugin marketplace add wenbinio/claudeorchestratortocodex
/plugin install codex-fleet@wenbinio
```

Updates: `/plugin marketplace update wenbinio`. Version bumps in plugin.json gate update visibility.

## Path variables

- `${CLAUDE_PLUGIN_ROOT}` — absolute path to the installed plugin (cache dir). Usable in skill/agent content and hook commands to reference bundled files (e.g. the workflow script).
- `${CLAUDE_PLUGIN_DATA}` — persistent per-plugin data dir (`~/.claude/plugins/data/<id>/`); survives updates. Machine config, telemetry, and approved.json live here.
- Plugins cannot reference files outside their own directory.

## Directory conventions

`skills/<name>/SKILL.md` (YAML frontmatter: only `name` and `description`, max 1024 chars, description starts "Use when...")
`agents/<name>.md` (subagent definitions; markdown frontmatter `name`, `description`, optional `tools`, body = system prompt)
`hooks/hooks.json` (hook registrations; `${CLAUDE_PLUGIN_ROOT}` allowed in commands)
Any other dirs (workflows/, scripts/, docs/) ride along and are reachable via `${CLAUDE_PLUGIN_ROOT}`.

CAVEAT (spec A7.1): a bundled `workflows/*.js` script is readable but there is NO documented stock tool that executes it — the `Workflow` tool is not part of the documented Claude Code tool surface. The dispatch skill must carry a full Agent-tool orchestration fallback; the engine script is an accelerator on installations where a workflow runtime exists.

## Cloud sandbox constraints (README material)

- Cloud sessions cannot run `/plugin`; they load plugins from the target repo's checked-in `.claude/settings.json`:

```json
{
  "enabledPlugins": { "codex-fleet@<marketplace-name>": true },
  "extraKnownMarketplaces": {
    "<marketplace-name>": {
      "source": { "source": "github", "repo": "wenbinio/claudeorchestratortocodex" }
    }
  }
}
```

- Skills and agents load in cloud sandboxes. Hooks (repo-level AND plugin) DO run in cloud sessions with `CLAUDE_CODE_REMOTE=true` set — an earlier version of this file claimed hooks were local-only; that was stale research, corrected per spec A7.11. Monitors and LSP servers remain CLI-only.
- Codex CLI in a sandbox: `npm i -g @openai/codex`, auth via `OPENAI_API_KEY` env secret (interactive ChatGPT OAuth is impossible headless). No key → the plugin's Claude-only fallback mode.
