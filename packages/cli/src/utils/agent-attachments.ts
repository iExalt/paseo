import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { lookup } from "mime-types";
import {
  AgentAttachmentSchema,
  ForgeSearchItemSchema,
  type AgentAttachment,
} from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export const collectAttachment = (value: string, previous: string[]) => [...previous, value];
type PreparedAttachment =
  | { kind: "text"; text: string }
  | { kind: "file"; fileName: string; mimeType: string; bytes: Uint8Array }
  | { kind: "issue" | "change_request"; url: string };

export async function prepareAttachments(values: string[] = []): Promise<PreparedAttachment[]> {
  const prepared: PreparedAttachment[] = [];
  for (const value of values) {
    const separator = value.indexOf(":");
    const kind = value.slice(0, separator);
    const content = value.slice(separator + 1);
    if (separator < 0 || !content.trim())
      throw new Error(
        "Use --attach text:<text>, file:<path>, github-issue:<url>, or github-pr:<url>.",
      );
    if (kind === "text") prepared.push({ kind, text: content });
    else if (kind === "file") {
      const info = await stat(content);
      if (!info.isFile() || info.size > 50 * 1024 * 1024)
        throw new Error(`Attachment must be a file no larger than 50MiB: ${content}`);
      const bytes = await readFile(content);
      if (bytes.byteLength > 50 * 1024 * 1024)
        throw new Error(`Attachment exceeds 50MiB: ${content}`);
      prepared.push({
        kind,
        fileName: basename(content),
        mimeType: lookup(content) || "application/octet-stream",
        bytes,
      });
    } else if (kind === "github-issue" || kind === "github-pr") {
      const url = new URL(content);
      const expected = kind === "github-issue" ? "issues" : "pull";
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !new RegExp(`^/[^/]+/[^/]+/${expected}/[1-9][0-9]*/?$`).test(url.pathname) ||
        url.search + url.hash
      )
        throw new Error(`Invalid ${kind} URL: ${content}`);
      url.pathname = url.pathname.replace(/\/$/, "");
      prepared.push({ kind: kind === "github-issue" ? "issue" : "change_request", url: url.href });
    } else throw new Error(`Unknown attachment kind: ${kind}`);
  }
  return prepared;
}

export async function resolveAttachments(
  client: Pick<DaemonClient, "uploadFile" | "searchForge" | "getLastServerInfoMessage">,
  prepared: PreparedAttachment[],
  cwd: string,
): Promise<AgentAttachment[]> {
  const result: AgentAttachment[] = [];
  for (const attachment of prepared) {
    if (attachment.kind === "text")
      result.push({ type: "text", mimeType: "text/plain", text: attachment.text });
    else if (attachment.kind === "file") {
      const uploaded = await client.uploadFile(attachment);
      if (uploaded.error || !uploaded.file)
        throw new Error(uploaded.error ?? "File upload failed.");
      result.push(uploaded.file);
    } else {
      // COMPAT(forgeSearch): added in v0.27.0, remove after 2027-05-14 once daemon floor supports forgeSearch.
      if (client.getLastServerInfoMessage()?.features?.forgeSearch !== true)
        throw new Error("Update the host to attach forge issues and pull requests.");
      const response = await client.searchForge({
        cwd,
        query: attachment.url,
        kinds: [attachment.kind],
        limit: 50,
      });
      if (response.error) throw new Error(response.error);
      const matches = response.items
        .map((item) => ForgeSearchItemSchema.parse(item))
        .filter(
          (item) => item.kind === attachment.kind && item.url.replace(/\/$/, "") === attachment.url,
        );
      if (matches.length !== 1)
        throw new Error(`Could not resolve exactly one attachment: ${attachment.url}`);
      const item = matches[0]!;
      result.push(
        AgentAttachmentSchema.parse({
          type: attachment.kind === "issue" ? "forge_issue" : "forge_change_request",
          mimeType:
            attachment.kind === "issue"
              ? "application/paseo-forge-issue"
              : "application/paseo-forge-change-request",
          forge: item.forge ?? "github",
          number: item.number,
          title: item.title,
          url: item.url,
          body: item.body,
          projectPath: item.projectPath,
          ...(attachment.kind === "change_request"
            ? { baseRefName: item.baseRefName, headRefName: item.headRefName }
            : {}),
        }),
      );
    }
  }
  return result;
}

export function mergeAttachments(
  explicit: AgentAttachment[],
  inherited: AgentAttachment[] = [],
): AgentAttachment[] {
  return [...inherited, ...explicit];
}
