import { listTerminalWorkerRecords } from "./terminal-worker-record.js";
import {
  createTerminalWorkerProcessInspector,
  type TerminalWorkerProcessInspector,
} from "./terminal-worker-processes.js";
import {
  classifyTerminalWorkerProcess,
  classifyTerminalProgramProcess,
} from "./terminal-worker-ownership.js";
/** Read-only: an empty worker exits when its daemon disconnects; live terminals are never closed. */
export async function terminalUpdateBlockers(
  paseoHome: string,
  options: {
    allowEmptyWorkers?: boolean;
    inspector?: TerminalWorkerProcessInspector;
  } = {},
): Promise<boolean> {
  const inspector = options.inspector ?? createTerminalWorkerProcessInspector();
  for (const file of await listTerminalWorkerRecords(paseoHome)) {
    if ("error" in file) return true;
    const worker = classifyTerminalWorkerProcess(
      file.record,
      await inspector.inspect(file.record.pid),
    );
    if (worker.status === "unknown" || (worker.status === "owned" && !options.allowEmptyWorkers))
      return true;
    for (const terminal of file.record.terminals) {
      const ownership = classifyTerminalProgramProcess(
        terminal,
        await inspector.inspect(terminal.pid),
      );
      if (ownership.status === "owned" || ownership.status === "unknown") return true;
    }
    // A cleanup can retain a descendant whose original terminal program has exited.
    for (const unresolved of file.record.closing?.unresolved ?? []) {
      if ((await inspector.inspect(unresolved.pid)).status !== "not-found") return true;
    }
  }
  return false;
}
