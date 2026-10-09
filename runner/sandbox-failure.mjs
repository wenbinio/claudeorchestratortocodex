export const SANDBOX_SETUP_REMEDY =
  'Use isolation: "plugins-off" (or "ignore-user-config" with an explicit model on exec); ' +
  'close the Codex desktop app (it runs node_repl.exe), or explicitly opt in to windowsSandbox: "unelevated" (a weaker sandbox).';

export function hasSandboxSetupFailure(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return /setup refresh had errors/i.test(text ?? "");
}

export function classifySandboxFailure(result, events = []) {
  if (events.some(hasSandboxSetupFailure)) {
    result.status = "failed";
    result.failureReason = "sandbox_setup_failed";
    result.remedy = SANDBOX_SETUP_REMEDY;
  }
  return result;
}
