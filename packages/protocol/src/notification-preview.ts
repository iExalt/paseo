import { z } from "zod";

// Push content is display-only. Its anchor never establishes loaded timeline coverage.
export const NotificationPreviewSchema = z.discriminatedUnion("kind", [
  z.object({
    v: z.literal(1),
    kind: z.literal("assistant"),
    epoch: z.string().min(1).max(200),
    seqStart: z.number().int().nonnegative(),
    seqEnd: z.number().int().nonnegative(),
    timestamp: z.string().datetime(),
    text: z.string().min(1).max(4_000),
    truncated: z.boolean(),
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal("permission"),
    requestId: z.string().min(1).max(200),
    text: z.string().min(1).max(4_000),
    truncated: z.boolean(),
  }),
]);

export type NotificationPreview = z.infer<typeof NotificationPreviewSchema>;

/** Fit optional preview text to the serialized payload, including Unicode and JSON escapes. */
export function boundNotificationPreview<T extends { data?: Record<string, unknown> }>(
  payload: T,
  maxBytes: number,
): T {
  const preview = payload.data?.preview;
  if (
    !preview ||
    typeof preview !== "object" ||
    !("text" in preview) ||
    typeof preview.text !== "string"
  ) {
    return payload;
  }
  const encoder = new TextEncoder();
  const fits = (value: T) => encoder.encode(JSON.stringify(value)).byteLength <= maxBytes;
  if (fits(payload)) return payload;
  const text = preview.text;
  const candidate = (length: number): T => {
    // Do not split a surrogate pair at the byte-budget boundary.
    const last = text.charCodeAt(length - 1);
    const end = last >= 0xd800 && last <= 0xdbff ? length - 1 : length;
    return {
      ...payload,
      data: { ...payload.data, preview: { ...preview, text: text.slice(0, end), truncated: true } },
    };
  };
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(candidate(middle))) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && fits(candidate(low))) return candidate(low);
  const data = { ...payload.data };
  delete data.preview;
  return { ...payload, data };
}
