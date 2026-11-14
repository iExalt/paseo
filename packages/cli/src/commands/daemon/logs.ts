import { Command } from "commander";
import { open } from "node:fs/promises";
import { daemonLogPath } from "@getpaseo/server/daemon-control";
import { addJsonOption, addLocalDaemonOptions } from "../../utils/command-options.js";
import { waitForStop } from "../../utils/wait-for-stop.js";
import { withOutput, type CommandOptions } from "../../output/index.js";

const CHUNK_SIZE = 64 * 1024;

export async function readLogTail(file: string, lines: number) {
  const handle = await open(file, "r");
  try {
    const metadata = await handle.stat();
    let position = lines === 0 ? 0 : metadata.size;
    const chunks: Buffer[] = [];
    let newlines = 0;
    while (position > 0 && newlines <= lines) {
      const size = Math.min(position, CHUNK_SIZE);
      position -= size;
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, position);
      const chunk = buffer.subarray(0, bytesRead);
      newlines += chunk.filter((byte) => byte === 10).length;
      chunks.unshift(chunk);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const entries = text.split("\n");
    if (entries.at(-1) === "") entries.pop();
    const tail = lines === 0 ? "" : entries.slice(-lines).join("\n");
    return {
      text: tail,
      endsWithNewline: text.endsWith("\n"),
      size: metadata.size,
      ino: metadata.ino,
    };
  } finally {
    await handle.close();
  }
}

export function daemonLogsCommand(): Command {
  return addJsonOption(addLocalDaemonOptions(new Command("logs")))
    .description("Read the selected local daemon log")
    .option("--tail <n>", "Number of historical lines", "100")
    .option("-f, --follow", "Follow appended log output until stopped")
    .action(withOutput(runDaemonLogs));
}

export async function runDaemonLogs(
  options: CommandOptions & { tail?: string; follow?: boolean },
  _command: Command,
) {
  if (options.daemonTarget.kind !== "instance") {
    throw { code: "LOCAL_ONLY", message: "Daemon logs require a local home." };
  }
  const lines = Number(options.tail ?? "100");
  if (!Number.isSafeInteger(lines) || lines < 0) {
    throw { code: "INVALID_TAIL", message: "--tail must be a nonnegative integer." };
  }
  const format = options.json ? "json" : options.format?.trim().toLowerCase();
  if (options.follow && (format === "json" || format === "yaml")) {
    throw { code: "INVALID_FORMAT", message: "Following daemon logs requires text output." };
  }
  const file = daemonLogPath(options.daemonTarget.home);
  const initial = await readLogTail(file, lines);
  if (options.follow) {
    if (initial.text) process.stdout.write(initial.text + (initial.endsWithNewline ? "\n" : ""));
    let offset = initial.size;
    let ino = initial.ino;
    let pending: Promise<unknown> = Promise.resolve();
    let failure: unknown;
    let busy = false;
    async function readAvailable() {
      const handle = await open(file, "r");
      try {
        const metadata = await handle.stat();
        if (metadata.ino !== ino || metadata.size < offset) offset = 0;
        ino = metadata.ino;
        while (offset < metadata.size) {
          const size = Math.min(CHUNK_SIZE, metadata.size - offset);
          const buffer = Buffer.alloc(size);
          const { bytesRead } = await handle.read(buffer, 0, size, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
          process.stdout.write(buffer.subarray(0, bytesRead));
        }
      } finally {
        await handle.close();
        busy = false;
      }
    }
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      pending = pending.then(readAvailable).catch((error: unknown) => {
        failure = error;
        clearInterval(timer);
        process.emit("SIGTERM");
      });
    }, 250);
    try {
      await waitForStop();
    } finally {
      clearInterval(timer);
      await pending;
    }
    if (failure) throw failure;
    return {
      type: "single" as const,
      data: { file, text: "" },
      schema: { idField: () => "logs", columns: [], renderHuman: () => "" },
    };
  }
  const data = { file, text: initial.text };
  return {
    type: "single" as const,
    data,
    schema: {
      idField: () => "logs",
      columns: [],
      renderHuman: () => initial.text,
    },
  };
}
