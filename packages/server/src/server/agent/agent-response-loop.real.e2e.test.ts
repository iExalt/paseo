import { describe, test, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { z } from "zod";
import { generateStructuredAgentResponse } from "./agent-response-loop.js";
import { AgentManager } from "./agent-manager.js";
import { shutdownProviders } from "./provider-registry.js";
import {
  canRunRealProvider,
  createRealProviderClients,
  getRealProviderConfig,
} from "../daemon-e2e/real-provider-test-config.js";
import pino from "pino";

const CODEX_TEST_MODEL = getRealProviderConfig("codex").model;
const CODEX_TEST_THINKING_OPTION_ID = getRealProviderConfig("codex").thinkingOptionId;
const CLAUDE_TEST_MODEL = getRealProviderConfig("claude").model;

describe("getStructuredAgentResponse (e2e)", () => {
  let manager: AgentManager;
  let cwd: string;
  let canRunCodex = false;
  let canRunClaude = false;
  const logger = pino({ level: "silent" });

  beforeAll(async () => {
    canRunCodex = await canRunRealProvider("codex");
    canRunClaude = await canRunRealProvider("claude");
  });

  beforeEach(async () => {
    cwd = mkdtempSync(path.join(tmpdir(), "agent-response-loop-"));
    manager = new AgentManager({
      clients: createRealProviderClients(["codex", "claude"], logger),
      logger,
    });
  });

  afterEach(async () => {
    rmSync(cwd, { recursive: true, force: true });
    await shutdownProviders(logger);
  }, 60000);

  test("returns schema-valid JSON from a real Codex agent", async (context) => {
    if (!canRunCodex) {
      context.skip();
    }
    const schema = z.object({
      title: z.string(),
      count: z.number(),
    });

    const result = await generateStructuredAgentResponse({
      manager,
      agentConfig: {
        provider: "codex",
        model: CODEX_TEST_MODEL,
        ...(CODEX_TEST_THINKING_OPTION_ID
          ? { thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID }
          : {}),
        cwd,
        title: "Structured Response Test",
      },
      prompt: "Return JSON with a short title and count 2.",
      schema,
      maxRetries: 1,
    });

    expect(result.title.length).toBeGreaterThan(0);
    expect(typeof result.count).toBe("number");
  }, 180000);

  test("returns schema-valid JSON from Claude Haiku", async (context) => {
    if (!canRunClaude) {
      context.skip();
    }
    const schema = z.object({
      message: z.string(),
    });

    let result: { message: string } | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        result = await generateStructuredAgentResponse({
          manager,
          agentConfig: {
            provider: "claude",
            model: CLAUDE_TEST_MODEL,
            thinkingOptionId: "on",
            cwd,
            title: "Claude Haiku Structured Test",
            internal: true,
          },
          prompt:
            'Respond with exactly this JSON (no markdown, no extra keys, no extra text): {"message":"hello"}',
          schema,
          maxRetries: 6,
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!result) {
      throw lastError;
    }

    expect(result.message.trim().toLowerCase()).toBe("hello");
  }, 180000);

  test("does not run the project's Claude hooks for an internal Claude agent", async (context) => {
    if (!canRunClaude) {
      context.skip();
    }
    const hookMarker = path.join(cwd, "stop-hook-ran");
    mkdirSync(path.join(cwd, ".claude"));
    writeFileSync(
      path.join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: `touch '${hookMarker}'` }] }],
        },
      }),
    );

    const result = await generateStructuredAgentResponse({
      manager,
      agentConfig: {
        provider: "claude",
        model: CLAUDE_TEST_MODEL,
        cwd,
        title: "Branch name generator",
        internal: true,
      },
      prompt:
        'Respond with exactly this JSON (no markdown, no extra keys, no extra text): {"message":"hello"}',
      schema: z.object({ message: z.string() }),
      maxRetries: 2,
      persistSession: false,
    });

    expect(result.message.trim().toLowerCase()).toBe("hello");
    expect(existsSync(hookMarker)).toBe(false);
  }, 180000);
});
