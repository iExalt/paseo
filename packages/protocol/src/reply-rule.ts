import { z } from "zod";

export const ReplyRuleSchema = z
  .object({
    source: z.string(),
    flags: z.string(),
  })
  .strict();
export type ReplyRule = z.infer<typeof ReplyRuleSchema>;
