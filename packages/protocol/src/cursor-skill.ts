import { z } from "zod";

export const CursorSkillReferenceSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  scope: z.enum(["workspace", "user"]),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});

export type CursorSkillReference = z.infer<typeof CursorSkillReferenceSchema>;

/** Punctuation that may follow a skill token without being part of its name. */
export const SKILL_TOKEN_TRAILING_PUNCTUATION = /[.,;:!?)\]}"']$/;

/**
 * Splits text into prose and code: odd indexes hold ``` fences and `inline code`, which never
 * carry skill tokens. Rejoining the parts gives back the text.
 */
export function splitSkillTokenCode(text: string): string[] {
  return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/);
}

/**
 * Whether a skill name can be typed as a `/name` token: no whitespace, slash or backtick, and no
 * trailing punctuation that the token grammar strips.
 */
export function isCursorSkillTokenName(name: string): boolean {
  return /^[^\s/`]+$/.test(name) && !SKILL_TOKEN_TRAILING_PUNCTUATION.test(name);
}

export const CursorSkillAttachmentSchema = z.object({
  type: z.literal("cursor_skill"),
  reference: CursorSkillReferenceSchema,
});
