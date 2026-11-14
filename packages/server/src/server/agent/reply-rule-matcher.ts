import { RE2 } from "re2-wasm";

import { COMPLETION_SUBJECT_MAX_LENGTH, type CompletionSubject } from "./completion-subject.js";

export const REPLY_RULE_MAX_COUNT = 8;
export const REPLY_RULE_MAX_PATTERN_LENGTH = 256;

export interface ReplyRule {
  readonly source: string;
  readonly flags: string;
}

export class ReplyRuleMatcher {
  private constructor(private readonly patterns: readonly RE2[]) {}

  static compile(rules: readonly ReplyRule[]): ReplyRuleMatcher {
    if (rules.length > REPLY_RULE_MAX_COUNT) {
      throw new RangeError(`At most ${REPLY_RULE_MAX_COUNT} reply rules are allowed`);
    }

    const patterns = rules.map((rule) => {
      if (rule.source.length > REPLY_RULE_MAX_PATTERN_LENGTH) {
        throw new RangeError(
          `Reply rule patterns may not exceed ${REPLY_RULE_MAX_PATTERN_LENGTH} UTF-16 code units`,
        );
      }
      const flags = normalizeFlags(rule.flags);
      return new RE2(rule.source, flags);
    });

    return new ReplyRuleMatcher(Object.freeze(patterns));
  }

  matches(subject: CompletionSubject | undefined): boolean {
    if (!subject || classifyReplySubject(subject)) return false;
    return this.patterns.some((pattern) => pattern.test(subject.text));
  }
}

export type ReplySubjectFailOpenReason =
  | "missing_subject"
  | "incomplete_subject"
  | "oversize_subject";

/** Why a completion subject cannot be judged by reply rules, or null when it can. */
export function classifyReplySubject(
  subject: CompletionSubject | undefined,
): ReplySubjectFailOpenReason | null {
  if (!subject) return "missing_subject";
  if (subject.completeness !== "complete") return "incomplete_subject";
  if (subject.text.length > COMPLETION_SUBJECT_MAX_LENGTH) return "oversize_subject";
  return null;
}

function normalizeFlags(flags: string): string {
  const seen = new Set<string>();
  for (const flag of flags) {
    if (flag !== "i" && flag !== "m" && flag !== "u") {
      throw new SyntaxError(`Unsupported reply rule flag: ${flag}`);
    }
    if (seen.has(flag)) {
      throw new SyntaxError(`Duplicate reply rule flag: ${flag}`);
    }
    seen.add(flag);
  }
  return `${seen.has("i") ? "i" : ""}${seen.has("m") ? "m" : ""}u`;
}
