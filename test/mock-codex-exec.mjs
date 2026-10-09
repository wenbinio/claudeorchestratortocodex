import readline from "node:readline";

const args = process.argv.slice(2);
const send = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

if (args.includes("exec")) {
  let prompt = "";
  if (!args.includes("resume")) {
    for await (const line of readline.createInterface({ input: process.stdin })) prompt += `${line}\n`;
  }
  send({ type: "thread.started", thread_id: "mock-exec-session" });
  send({ type: "item.completed", item: { id: "argv", type: "command_execution",
    command: "mock argv", exit_code: 0, aggregated_output: JSON.stringify(args) } });
  const token = /FLEET_SHELL_[a-zA-Z0-9_]+/.exec(prompt)?.[0];
  const sandboxFailed = args.includes("--mock-sandbox-error") ||
    (args.includes("--mock-require-unelevated") && !args.includes('windows.sandbox="unelevated"')) ||
    (args.includes("--mock-require-ignore") && !args.includes("--ignore-user-config"));
  if (sandboxFailed) {
    // A tool/CreateProcess rejection may arrive without a command_execution item.
    send({ type: "item.completed", item: { id: "rejection", type: "tool_result", tool: "exec_command",
      error: { message: "CreateProcess rejected: Failed to create unified exec process: helper_unknown_error: setup refresh had errors" } } });
  } else if (token && !args.includes("--mock-chat-only")) {
    send({ type: "item.completed", item: { id: "shell", type: "command_execution", command: `echo ${token}`,
      exit_code: 0, aggregated_output: `${token}\n` } });
  }
  if (args.includes("--mock-resume") && !args.includes("resume")) {
    setInterval(() => {}, 1000);
  } else {
    send({ type: "item.completed", item: { id: "answer", type: "agent_message", phase: "final_answer", text: token ?? "done" } });
    send({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
  }
}
