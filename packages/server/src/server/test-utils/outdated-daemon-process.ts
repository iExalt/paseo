import { readFile } from "node:fs/promises";
import path from "node:path";
import { createTestPaseoDaemon } from "./paseo-daemon.js";

async function main(): Promise<void> {
  const webOrigin = process.env.E2E_WEB_ORIGIN;
  if (!webOrigin) {
    throw new Error("E2E_WEB_ORIGIN is not set");
  }

  const daemon = await createTestPaseoDaemon({
    corsAllowedOrigins: [webOrigin],
    daemonVersion: "0.0.0",
    desktopManaged: process.env.E2E_DESKTOP_MANAGED === "1",
    daemonStatusRpcCapability: process.env.E2E_DAEMON_STATUS_RPC_CAPABILITY !== "0",
    relayConfigCapability: process.env.E2E_RELAY_CONFIG_CAPABILITY !== "0",
  });
  const serverId = (await readFile(path.join(daemon.paseoHome, "server-id"), "utf8")).trim();

  process.send?.({
    type: "ready",
    endpoint: `127.0.0.1:${daemon.port}`,
    serverId,
  });

  const shutdown = async () => {
    await daemon.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void main().catch((error) => {
  process.send?.({
    type: "error",
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  });
  process.exit(1);
});
