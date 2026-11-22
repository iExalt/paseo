import { z } from "zod";

export const CursorSkillReferenceSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  scope: z.enum(["workspace", "user"]),
  id: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
});

export type CursorSkillReference = z.infer<typeof CursorSkillReferenceSchema>;

export const CursorSkillAttachmentSchema = z.object({
  type: z.literal("cursor_skill"),
  reference: CursorSkillReferenceSchema,
});
