import { z } from "zod";

export const CursorSkillReferenceSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  scope: z.enum(["workspace", "user"]),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});

export type CursorSkillReference = z.infer<typeof CursorSkillReferenceSchema>;

const cursorSkillTokenEnd = /[.,;:!?)\]}"']$/;

/**
 * Whether a skill name can be typed as a `/name` token: no whitespace, slash or backtick, and no
 * trailing punctuation that the token grammar strips.
 */
export function isCursorSkillTokenName(name: string): boolean {
  return /^[^\s/`]+$/.test(name) && !cursorSkillTokenEnd.test(name);
}

export const CursorSkillAttachmentSchema = z.object({
  type: z.literal("cursor_skill"),
  reference: CursorSkillReferenceSchema,
});
