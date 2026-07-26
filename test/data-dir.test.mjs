import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveDataDir } from "../runner/lib/data-dir.mjs";

test("CLAUDE_PLUGIN_DATA is authoritative and returned verbatim", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-fleet-data-dir-env-"));
  const dataRoot = path.join(home, ".claude", "plugins", "data");

  try {
    await Promise.all([
      mkdir(path.join(dataRoot, "codex-fleet"), { recursive: true }),
      mkdir(path.join(dataRoot, "codex-fleet-inline"), { recursive: true }),
    ]);
    await writeFile(path.join(dataRoot, "codex-fleet-inline", "config.json"), "{}\n", "utf8");

    const authoritative = path.join("host-provided", "codex-fleet-data");
    assert.equal(
      await resolveDataDir({ env: { CLAUDE_PLUGIN_DATA: authoritative }, home }),
      authoritative,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a deterministic config-containing match wins over matches without config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-fleet-data-dir-match-"));
  const dataRoot = path.join(home, ".claude", "plugins", "data");
  const bare = path.join(dataRoot, "codex-fleet");
  const configuredFirst = path.join(dataRoot, "codex-fleet-inline");
  const configuredSecond = path.join(dataRoot, "codex-fleet-wenbinio");

  try {
    await Promise.all([
      mkdir(bare, { recursive: true }),
      mkdir(configuredFirst, { recursive: true }),
      mkdir(configuredSecond, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(configuredFirst, "config.json"), "{}\n", "utf8"),
      writeFile(path.join(configuredSecond, "config.json"), "{}\n", "utf8"),
    ]);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => resolveDataDir({ env: {}, home })),
    );
    assert.deepEqual(results, Array(20).fill(configuredFirst));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the lexicographically-first match wins when no match contains config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-fleet-data-dir-unconfigured-"));
  const dataRoot = path.join(home, ".claude", "plugins", "data");

  try {
    await Promise.all([
      mkdir(path.join(dataRoot, "codex-fleet-wenbinio"), { recursive: true }),
      mkdir(path.join(dataRoot, "codex-fleet-inline"), { recursive: true }),
    ]);

    assert.equal(
      await resolveDataDir({ env: {}, home }),
      path.join(dataRoot, "codex-fleet-inline"),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the bare plugin data name is used when nothing matches", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-fleet-data-dir-default-"));

  try {
    assert.equal(
      await resolveDataDir({ env: {}, home }),
      path.join(home, ".claude", "plugins", "data", "codex-fleet"),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
