import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentMetadata } from "@/attachments/types";
import { getFileNameFromPath } from "@/attachments/utils";
import type { AssistantImageSourceResolution } from "@/utils/assistant-image-source";
import {
  createAssistantImageFileAcquisitionKey,
  createAssistantImageFilePreviewAttachmentId,
} from "./acquisition-cache";

// A preview never needs more; the daemon refuses a larger file instead of streaming all of it.
// The daemon also picks "image" by extension alone, so ![x](big.log) would otherwise be read whole.
export const ASSISTANT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

export interface AssistantImageFileAcquisitionPort {
  readFile(cwd: string, path: string, maxBytes: number): Promise<FileReadResult>;
  persist(input: {
    id: string;
    bytes: Uint8Array;
    mimeType: string;
    fileName: string | null;
  }): Promise<AttachmentMetadata>;
}

export interface AssistantImageAcquisition {
  key: string;
  locate: () => Promise<AttachmentMetadata>;
}

export function createAssistantImageFileAcquisition(input: {
  port: AssistantImageFileAcquisitionPort | null;
  resolution: AssistantImageSourceResolution | null;
  serverId?: string;
  occurrenceKey: string;
  unavailableMessage: string;
}): AssistantImageAcquisition | null {
  if (input.resolution?.kind !== "file_rpc") {
    return null;
  }
  const { port, resolution } = input;
  return {
    key: createAssistantImageFileAcquisitionKey({
      serverId: input.serverId,
      occurrenceKey: input.occurrenceKey,
      cwd: resolution.cwd,
      path: resolution.path,
    }),
    locate: async () => {
      if (!port) {
        throw new Error(input.unavailableMessage);
      }
      const file = await port.readFile(resolution.cwd, resolution.path, ASSISTANT_IMAGE_MAX_BYTES);
      if (file.kind !== "image") {
        throw new Error(input.unavailableMessage);
      }
      return await port.persist({
        id: createAssistantImageFilePreviewAttachmentId({
          serverId: input.serverId,
          occurrenceKey: input.occurrenceKey,
          mimeType: file.mime,
          path: file.path || resolution.path,
          size: file.size,
          modifiedAt: file.modifiedAt,
          contentLength: file.bytes.byteLength,
        }),
        bytes: file.bytes,
        mimeType: file.mime,
        fileName: getFileNameFromPath(file.path || resolution.path),
      });
    },
  };
}
