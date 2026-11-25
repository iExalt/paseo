import { randomUUID } from "node:crypto";
import type { SDKCustomTool, SDKCustomToolResult } from "@cursor/sdk";
import { z } from "zod";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentStreamEvent,
} from "../agent-sdk-types.js";

const provider = "cursor-sdk";
const name = "ask_question";

// Antigravity CLI 1.5.14 model-facing ask_question declaration.
const questionSchema = z.strictObject({
  question: z
    .string()
    .min(1)
    .describe("The question, without 'select all that apply' or similar; the UI adds that."),
  options: z
    .array(z.string())
    .min(2)
    .describe(
      "Answers to choose from, unnumbered and without an 'Other' option; the UI adds both. Put a recommended answer first, prefixed with '(Recommended)'.",
    ),
  is_multi_select: z.boolean().optional().describe("Whether the user can select several options."),
});
const inputSchema = z.strictObject({ questions: z.array(questionSchema).min(1) });
const answersSchema = z.record(z.string(), z.string().trim().min(1).max(8000));

type QuestionInput = z.infer<typeof inputSchema>;
interface PendingQuestion {
  request: AgentPermissionRequest;
  headers: string[];
  finish: (result: SDKCustomToolResult) => void;
}

function errorResult(text: string): SDKCustomToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export const cursorQuestionToolName = name;
export const cursorQuestionToolDescriptor = {
  description:
    "Ask the user one or more multiple-choice questions, e.g. to clarify requirements, and wait for the answers. Don't use it for trivial yes/no questions; ask those in plain text.",
  inputSchema: z.toJSONSchema(inputSchema, { io: "input" }) as NonNullable<
    SDKCustomTool["inputSchema"]
  >,
} satisfies Omit<SDKCustomTool, "execute">;

export class CursorQuestions {
  private readonly pending = new Map<string, PendingQuestion>();

  constructor(private readonly emit: (event: AgentStreamEvent) => void) {}

  requests(): AgentPermissionRequest[] {
    return [...this.pending.values()].map(({ request }) => request);
  }

  tool(signal: AbortSignal): SDKCustomTool {
    // The transport may replay an in-flight call. Keep its promise within the
    // turn so replay observes the same decision, including after resolution.
    const calls = new Map<string, { input: string; result: Promise<SDKCustomToolResult> }>();
    return {
      ...cursorQuestionToolDescriptor,
      execute: (args, context) => {
        if (signal.aborted) return errorResult("The question was canceled.");
        if (typeof context?.toolCallId !== "string" || !context.toolCallId)
          return errorResult("Cursor did not identify the question call.");
        const parsed = inputSchema.safeParse(args);
        if (!parsed.success) return errorResult(z.prettifyError(parsed.error));
        const key = JSON.stringify([context.sessionId, context.toolCallId]);
        const input = JSON.stringify(parsed.data);
        const existing = calls.get(key);
        if (existing) {
          return existing.input === input
            ? existing.result
            : errorResult("The question changed while retrying. Ask it as a new call.");
        }
        const result = this.ask(parsed.data, signal);
        calls.set(key, { input, result });
        return result;
      },
    };
  }

  private ask(input: QuestionInput, signal: AbortSignal): Promise<SDKCustomToolResult> {
    const id = randomUUID();
    const questions = input.questions.map((item, index) => ({
      header: `Question ${index + 1}`,
      question: item.question,
      options: item.options.map((label) => ({ label })),
      multiSelect: item.is_multi_select ?? false,
      allowOther: true,
    }));
    const title = input.questions[0].question.trim();
    const request: AgentPermissionRequest = {
      id,
      provider,
      name,
      kind: "question",
      ...(title ? { title } : {}),
      input: { questions },
    };
    return new Promise((resolve) => {
      const cancel = () => {
        this.settle(
          id,
          { behavior: "deny", message: "Question canceled" },
          errorResult("The question was canceled."),
        );
      };
      const finish = (result: SDKCustomToolResult) => {
        signal.removeEventListener("abort", cancel);
        resolve(result);
      };
      this.pending.set(id, { request, headers: questions.map(({ header }) => header), finish });
      signal.addEventListener("abort", cancel, { once: true });
      this.emit({ type: "permission_requested", provider, request });
    });
  }

  respond(id: string, response: AgentPermissionResponse): void {
    const pending = this.pending.get(id);
    if (!pending)
      throw new Error(
        "Cursor SDK question is no longer pending. Interactive tool approvals are unavailable.",
      );
    if (response.behavior === "deny") {
      this.settle(id, response, errorResult("The human dismissed the question."));
      return;
    }
    const parsed = answersSchema.safeParse(response.updatedInput?.answers);
    if (
      !parsed.success ||
      Object.keys(parsed.data).length !== pending.headers.length ||
      pending.headers.some((header) => !Object.hasOwn(parsed.data, header))
    ) {
      throw new Error("Provide a valid answer for every Cursor SDK question.");
    }
    const updatedInput = { answers: parsed.data };
    this.settle(id, { ...response, updatedInput }, updatedInput);
  }

  private settle(
    id: string,
    resolution: AgentPermissionResponse,
    result: SDKCustomToolResult,
  ): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.finish(result);
    this.emit({ type: "permission_resolved", provider, requestId: id, resolution });
  }
}
