const ISOLATION_MODES = new Set(["plugins-off", "ignore-user-config", "none"]);
const WINDOWS_SANDBOXES = new Set(["elevated", "unelevated"]);

export function validateWorkerConfig({ isolation = "plugins-off", windowsSandbox, model } = {}) {
  if (!ISOLATION_MODES.has(isolation)) {
    throw new TypeError("isolation must be 'plugins-off', 'ignore-user-config', or 'none'");
  }
  if (windowsSandbox !== undefined && !WINDOWS_SANDBOXES.has(windowsSandbox)) {
    throw new TypeError("windowsSandbox must be 'elevated' or 'unelevated'");
  }
  if (isolation === "ignore-user-config" && (typeof model !== "string" || !model.trim())) {
    throw new TypeError("isolation 'ignore-user-config' requires an explicit non-empty model");
  }
}

export function workerIsolationArgs(options = {}, backend = "exec") {
  validateWorkerConfig(options);
  const isolation = options.isolation ?? "plugins-off";
  const args = isolation === "ignore-user-config" && backend === "exec"
    ? ["--ignore-user-config"]
    : isolation === "none"
      ? []
      : ["--disable", "plugins", "-c", "mcp_servers.node_repl.enabled=false"];
  if (options.windowsSandbox !== undefined) {
    args.push("-c", `windows.sandbox=${JSON.stringify(options.windowsSandbox)}`);
  }
  return args;
}

export function workerIsolationNotes(options = {}, backend = "exec") {
  return options.isolation === "ignore-user-config" && backend === "app-server"
    ? ["app-server does not support ignore-user-config; isolation fell back to plugins-off."]
    : [];
}

export function appServerArgs(options = {}) {
  // Keep the script/launcher prefix supplied by tests; flags follow its argv.
  const base = Array.isArray(options.codexArgs) && options.codexArgs.length
    ? options.codexArgs
    : ["app-server", "--listen", "stdio://"];
  return [...base, ...workerIsolationArgs(options, "app-server")];
}
