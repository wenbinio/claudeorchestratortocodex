/**
 * Resolve the Codex Fleet plugin data directory with one deterministic algorithm:
 * use a non-empty host-provided CLAUDE_PLUGIN_DATA verbatim; otherwise scan
 * ~/.claude/plugins/data for /codex-fleet/ directories, preferring the
 * lexicographically-first match containing config.json and then the
 * lexicographically-first match; otherwise use the bare codex-fleet directory.
 */

import { constants as fsConstants, promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

async function containsConfig(directory) {
  try {
    await fsp.access(path.join(directory, "config.json"), fsConstants.F_OK);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function resolveDataDir({ env = process.env, home } = {}) {
  const authoritative = env?.CLAUDE_PLUGIN_DATA;
  if (typeof authoritative === "string" && authoritative.length > 0) {
    return authoritative;
  }

  const parent = path.join(home ?? os.homedir(), ".claude", "plugins", "data");
  let matches;
  try {
    matches = (await fsp.readdir(parent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /codex-fleet/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    matches = [];
  }

  for (const match of matches) {
    const directory = path.join(parent, match);
    if (await containsConfig(directory)) return directory;
  }

  return path.join(parent, matches[0] ?? "codex-fleet");
}
