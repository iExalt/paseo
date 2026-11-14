import { readFile, writeFile } from "node:fs/promises";
import { basename, posix } from "node:path";
import { lookup } from "mime-types";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";
import { connectToDaemon } from "../../utils/client.js";
import { requireFeature, resolveCheckoutCwd } from "../git/run.js";

export interface FileOptions extends CommandOptions {
  workspace?: string;
  cwd?: string;
  input?: string;
  kind?: "file" | "directory";
}
type FileOutput = Record<string, unknown>;
const schema: OutputSchema<FileOutput> = {
  idField: (row) => String(row.path ?? row.cwd ?? ""),
  columns: [{ header: "RESULT", field: (row) => JSON.stringify(row) }],
  renderHuman: (result) => {
    const data = result.type === "single" ? result.data : undefined;
    if (data?.operation === "cat") {
      if (data.kind !== "text")
        throw { code: "BINARY_FILE", message: "Use --json for base64 bytes, or file download" };
      const bytes = Buffer.from(String(data.content), "base64");
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw { code: "BINARY_FILE", message: "Use --json for base64 bytes, or file download" };
      }
    }
    return JSON.stringify(data, null, 2);
  },
};
async function inputBytes(input: string): Promise<Buffer> {
  if (input !== "-") return readFile(input);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
export async function runFileCommand(
  operation: string,
  args: string[],
  options: FileOptions,
  connect: typeof connectToDaemon = connectToDaemon,
): Promise<SingleResult<FileOutput>> {
  const client = await connect({ target: options.daemonTarget });
  try {
    const cwd = await resolveCheckoutCwd(client, options);
    const path = args[0] ?? "";
    let payload: object;
    switch (operation) {
      case "ls":
        payload = await client.listDirectory(cwd, path);
        break;
      case "cat": {
        const file = await client.readFile(cwd, path);
        const { bytes, ...metadata } = file;
        payload = {
          ...metadata,
          content: Buffer.from(bytes).toString("base64"),
          contentEncoding: "base64",
        };
        break;
      }
      case "download": {
        const file = await client.readFile(cwd, path);
        await writeFile(args[1]!, file.bytes, { flag: "wx" });
        payload = { localPath: args[1], size: file.bytes.byteLength };
        break;
      }
      case "write":
        payload = await overwriteFile(client, cwd, path, options);
        break;
      case "create":
        payload = await client.createFileEntry({
          cwd,
          parentPath: posix.dirname(path) === "." ? "" : posix.dirname(path),
          name: posix.basename(path),
          kind: options.kind ?? "file",
        });
        break;
      case "rename":
        payload = await client.renameFileEntry({ cwd, path, name: args[1]! });
        break;
      case "duplicate":
        payload = await client.duplicateFileEntry({ cwd, path });
        break;
      case "rm":
        payload = await client.deleteFileEntry({ cwd, path });
        break;
      case "upload": {
        const bytes = await readFile(path);
        payload = await client.uploadFile({
          fileName: basename(path),
          mimeType: lookup(path) || "application/octet-stream",
          bytes,
        });
        break;
      }
      case "suggest":
        payload = await client.getDirectorySuggestions({
          cwd,
          query: path,
          includeFiles: true,
          includeDirectories: true,
        });
        break;
      default:
        throw new Error("Unknown file operation: " + operation);
    }
    const data = { ...payload, cwd, operation } as FileOutput;
    if (data.path === undefined) data.path = path;
    if (data.error || data.success === false)
      throw {
        code: "FILE_OPERATION_FAILED",
        message: String(data.error ?? "File operation failed"),
        details: data,
      };
    return { type: "single", data, schema };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function overwriteFile(
  client: Awaited<ReturnType<typeof connectToDaemon>>,
  cwd: string,
  path: string,
  options: FileOptions,
): Promise<object> {
  requireFeature(client, "fileByteWrites");
  if (!options.input) throw { code: "INVALID_OPTIONS", message: "Pass --input <file|->" };
  const bytes = await inputBytes(options.input);
  const before = await client.readFile(cwd, path);
  const result = await client.writeFile({
    cwd,
    path,
    content: bytes.toString("base64"),
    contentEncoding: "base64",
    expectedModifiedAt: before.modifiedAt,
    expectedRevision: before.revision,
  });
  if (result.status !== "written")
    throw {
      code: result.status === "conflict" ? "FILE_CONFLICT" : "FILE_OPERATION_FAILED",
      message:
        result.status === "error"
          ? result.error
          : "File changed during write; read it again before retrying",
      details: result,
    };
  return result;
}
