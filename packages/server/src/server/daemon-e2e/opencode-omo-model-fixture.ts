import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const CHILD_PROMPT = "Wait for the first root turn to go idle.";
const CHILD_RESULT = "PASEO_OMO_CHILD_READY";

interface CompletionRequest {
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function: { name: string } }>;
}

/**
 * Script the language model while running the actual OpenCode server and OMO
 * plugin. The model replies to the wake only after OMO injects its completion
 * notification and background_output returns the real child result.
 */
export async function startOmoModelFixture() {
  let releaseChild!: () => void;
  const rootIdle = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const { messages, tools = [] } = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as CompletionRequest;
    const userText = JSON.stringify(messages.filter((message) => message.role === "user"));
    const toolOutput = JSON.stringify(messages.filter((message) => message.role === "tool"));
    const hasTool = (name: string) => tools.some((tool) => tool.function.name === name);
    let delta: unknown;
    let stopReason = "stop";

    if (tools.length === 0) {
      delta = { content: "OMO autonomous wake test" };
    } else if (userText.includes(CHILD_PROMPT)) {
      await rootIdle;
      delta = { content: CHILD_RESULT };
    } else if (userText.includes("[ALL BACKGROUND TASKS COMPLETE]")) {
      if (toolOutput.includes(CHILD_RESULT)) {
        delta = { content: "PASEO_OMO_AUTONOMOUS_FINAL" };
      } else {
        const taskId = userText.match(/bg_[a-zA-Z0-9]+/)?.[0];
        if (!taskId || !hasTool("background_output")) {
          throw new Error("OMO wake did not include a retrievable background task");
        }
        delta = toolCall("background_output", { task_id: taskId });
        stopReason = "tool_calls";
      }
    } else if (toolOutput.includes("Background task launched")) {
      delta = { content: "PASEO_OMO_ROOT_WAITING" };
    } else if (hasTool("task") && userText.includes("Use the OMO task tool")) {
      delta = toolCall("task", {
        category: "quick",
        description: "Wait until the root goes idle",
        prompt: CHILD_PROMPT,
        load_skills: [],
        run_in_background: true,
      });
      stopReason = "tool_calls";
    } else {
      throw new Error("Unexpected OpenCode model request in the OMO test");
    }

    const header = {
      id: randomUUID(),
      model: "fixture",
      object: "chat.completion.chunk",
      created: 0,
    };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of [
      { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { choices: [{ index: 0, delta, finish_reason: null }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: stopReason }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ]) {
      response.write(`data: ${JSON.stringify({ ...header, ...event })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  }

  const server = createServer((request, response) => {
    void respond(request, response).catch((error) => {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: String(error) } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OMO model fixture has no TCP port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    releaseChild,
    async close() {
      releaseChild();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function toolCall(name: string, args: Record<string, unknown>) {
  return {
    tool_calls: [
      {
        index: 0,
        type: "function",
        id: randomUUID(),
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}
