import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { afterEach, expect, test } from "vitest";

import { metroNodeOptions, waitForMetro, warmMetro } from "../e2e/support/global-setup";
import { getE2EWebBaseURL, getE2EWebOrigin } from "../e2e/support/web-url";

class MetroPort {
  private readonly responses = new Map<string, { status: number; body: string }>();
  readonly requests: string[] = [];

  private constructor(
    readonly port: number,
    private readonly server: Server,
  ) {}

  static async listen(): Promise<MetroPort> {
    let endpoint!: MetroPort;
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      endpoint.requests.push(pathname);
      const served = endpoint.responses.get(pathname) ?? { status: 500, body: "fallback" };
      response.writeHead(served.status, { "content-type": "text/plain" });
      response.end(served.body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Failed to listen for Metro readiness test");
    }
    endpoint = new MetroPort(address.port, server);
    return endpoint;
  }

  serveMetro(): void {
    this.responses.set("/status", { status: 200, body: "packager-status:running" });
  }

  serveWarmableDocument(): void {
    this.responses.set("/", {
      status: 200,
      body: '<html><script src="/index.bundle?platform=web"></script></html>',
    });
    this.responses.set("/index.bundle", { status: 200, body: "compiled bundle" });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}

let endpoint: MetroPort | null = null;

afterEach(async () => {
  await endpoint?.close();
  endpoint = null;
});

test("Metro readiness rejects another HTTP listener on the selected port", async () => {
  endpoint = await MetroPort.listen();

  await expect(waitForMetro(endpoint.port, { label: "Metro", timeoutMs: 150 })).rejects.toThrow(
    "Expected Metro status",
  );

  endpoint.serveMetro();
  await expect(waitForMetro(endpoint.port, { label: "Metro", timeoutMs: 150 })).resolves.toBe(
    undefined,
  );
});

test("Metro warmup compiles the document's same-origin scripts before tests start", async () => {
  endpoint = await MetroPort.listen();
  endpoint.serveWarmableDocument();

  await warmMetro(endpoint.port, `http://127.0.0.1:${endpoint.port}/override`);

  expect(endpoint.requests).toEqual(["/", "/index.bundle"]);
});

test("Metro appends IPv4 DNS ordering after inherited Node options", async () => {
  const options = metroNodeOptions("--dns-result-order=ipv6first --trace-warnings");
  const child = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(require('node:dns').getDefaultResultOrder())"],
    { env: { ...process.env, NODE_OPTIONS: options }, encoding: "utf8" },
  );

  expect(child.status).toBe(0);
  expect(child.stdout).toBe("ipv4first");
});

test("E2E web origins use IPv4 loopback and preserve configured base URL overrides", () => {
  expect(getE2EWebBaseURL(8081, {})).toBe("http://127.0.0.1:8081");
  expect(getE2EWebBaseURL(8081, { E2E_WEB_BASE_URL: "http://127.0.0.1:9000/custom" })).toBe(
    "http://127.0.0.1:9000/custom",
  );
  expect(
    getE2EWebBaseURL(8081, {
      E2E_BASE_URL: "http://127.0.0.1:6767",
      E2E_WEB_BASE_URL: "http://127.0.0.1:9000",
    }),
  ).toBe("http://127.0.0.1:6767");
  expect(getE2EWebOrigin(8081, { E2E_WEB_BASE_URL: "http://127.0.0.1:9000/custom" })).toBe(
    "http://127.0.0.1:9000",
  );
});
