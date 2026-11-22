import { randomUUID } from "node:crypto";
import type { SDKCustomTool, SDKCustomToolResult } from "@cursor/sdk";
import { z } from "zod";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentStreamEvent,
} from "../agent-sdk-types.js";

const provider = "cursor-sdk";
const name = "ask_user_question";

const questionSchema = z.object({
  header: z.string().trim().min(1).max(12),
  question: z.string().trim().min(1).max(2000),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(100),
        description: z.string().trim().max(500).optional(),
      }),
    )
    .max(6),
});
const inputSchema = z
  .object({ questions: z.array(questionSchema).min(1).max(3) })
  .refine(
    ({ questions }) =>
      questions.every(({ header }) => header !== "__proto__") &&
      new Set(questions.map(({ header }) => header)).size === questions.length &&
      questions.every(
        ({ options }) => new Set(options.map(({ label }) => label)).size === options.length,
      ),
  );
const answersSchema = z.record(z.string(), z.string().trim().min(1).max(8000));

type QuestionInput = z.infer<typeof inputSchema>;
interface PendingQuestion {
  request: AgentPermissionRequest;
  questions: QuestionInput["questions"];
  finish: (result: SDKCustomToolResult) => void;
}

function errorResult(text: string): SDKCustomToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export const cursorQuestionToolName = name;
export const cursorQuestionToolDescriptor = {
  description:
    "Ask the human up to three questions and wait for their answers. Include options for a choice or use an empty options array for free text.",
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
        if (!parsed.success)
          return errorResult("Invalid questions. Use unique headers and option labels.");
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
    const request: AgentPermissionRequest = {
      id,
      provider,
      name,
      kind: "question",
      input,
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
      this.pending.set(id, { request, questions: input.questions, finish });
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
      Object.keys(parsed.data).length !== pending.questions.length ||
      pending.questions.some(({ header, options }) => {
        const value = Object.hasOwn(parsed.data, header) ? parsed.data[header] : undefined;
        return !value || (options.length > 0 && !options.some(({ label }) => label === value));
      })
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
