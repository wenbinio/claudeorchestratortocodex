import { randomUUID } from "node:crypto";
import { createWorker } from "./transports/exec.mjs";
import { validateWorkerConfig } from "./codex-flags.mjs";
import { classifySandboxFailure, SANDBOX_SETUP_REMEDY } from "./sandbox-failure.mjs";

export function shellSmokePrompt(token) {
  return `Run a shell command that prints exactly ${token} (echo or Write-Output). ` +
    `You MUST execute the command successfully using the shell tool, then reply with exactly ${token}. Do not run git.`;
}

export function shellSmokePassed(result, events, token) {
  return result.status === "completed" && String(result.finalMessage ?? "").trim() === token &&
    events.some((event) => event.type === "commandExecution" && event.exitCode === 0 &&
      String(event.output ?? "").trim() === token);
}

// Try explicit alternatives, never repeat an unchanged broken worker. A passing
// weaker sandbox is diagnostic evidence until the caller opts in.
export async function runSetupSmoke(options, { platform = process.platform, makeWorker = createWorker } = {}) {
  validateWorkerConfig(options);
  const candidates = [{ isolation: "plugins-off", windowsSandbox: options.windowsSandbox }];
  if (platform === "win32" && options.windowsSandbox !== "unelevated") {
    candidates.push({ isolation: "plugins-off", windowsSandbox: "unelevated" });
  }
  if (options.model) candidates.push({ isolation: "ignore-user-config", windowsSandbox: options.windowsSandbox });
  const attempts = [];
  let weakerSandboxPassed = false;
  for (const candidate of candidates) {
    const token = `FLEET_SHELL_${randomUUID().replaceAll("-", "")}`;
    let worker;
    let result;
    try {
      worker = await makeWorker({ ...options, ...candidate, sandbox: "read-only", ephemeral: true });
      result = await worker.turn(shellSmokePrompt(token), { timeoutMs: options.timeoutMs });
    } catch (error) {
      result = classifySandboxFailure({ status: "failed", finalMessage: "", error: error?.message ?? String(error) }, [error?.message]);
    } finally {
      await worker?.close().catch(() => {});
    }
    const passed = shellSmokePassed(result, result.events ?? [], token);
    attempts.push({ ...candidate, passed, failureReason: result.failureReason, error: result.error });
    if (!passed) continue;
    if (candidate.windowsSandbox === "unelevated" && options.allowUnelevated !== true) {
      weakerSandboxPassed = true;
      continue;
    }
    return {
      compatible: true, backend: "exec", ...candidate, attempts,
      ...(candidate.windowsSandbox === "unelevated"
        ? { weakerSandbox: true, notes: ["unelevated is a weaker Windows sandbox; explicitly opted in with --allow-unelevated."] }
        : {}),
    };
  }
  if (weakerSandboxPassed) {
    return {
      compatible: false, backend: "exec", attempts, failureReason: "sandbox_setup_failed",
      weakerSandbox: true,
      error: `Shell smoke passed only with unelevated, a weaker sandbox; rerun setup with --allow-unelevated to record it. ${SANDBOX_SETUP_REMEDY}`,
      remedy: SANDBOX_SETUP_REMEDY,
    };
  }
  return {
    compatible: false, backend: "exec", attempts,
    failureReason: attempts.some((attempt) => attempt.failureReason === "sandbox_setup_failed")
      ? "sandbox_setup_failed" : "shell_smoke_failed",
    error: `Worker did not successfully execute the shell smoke. ${SANDBOX_SETUP_REMEDY}`,
    remedy: SANDBOX_SETUP_REMEDY,
  };
}
