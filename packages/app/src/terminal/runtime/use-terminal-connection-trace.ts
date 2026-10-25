import { useEffect } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import {
  TERMINAL_TRACE_ENABLED,
  traceTerminalEvent,
} from "@/terminal/native-renderer/terminal-input-trace";

const PING_INTERVAL_MS = 2_000;

/**
 * Dev-only: logs the connection a terminal's host uses and the daemon's RPC
 * round trip on it, so echo latency can be split into transport and terminal
 * time without stamps from the daemon.
 */
export function useTerminalConnectionTrace(input: {
  serverId: string;
  client: DaemonClient | null;
  active: boolean;
}): void {
  const { serverId, client, active } = input;
  const activeConnection = useHostRuntimeSnapshot(serverId)?.activeConnection ?? null;
  const connectionType = TERMINAL_TRACE_ENABLED ? (activeConnection?.type ?? null) : null;
  const connectionDisplay = TERMINAL_TRACE_ENABLED ? (activeConnection?.display ?? null) : null;

  useEffect(() => {
    if (!TERMINAL_TRACE_ENABLED) {
      return;
    }
    traceTerminalEvent({ connection: connectionType, display: connectionDisplay });
  }, [connectionType, connectionDisplay]);

  useEffect(() => {
    if (!TERMINAL_TRACE_ENABLED || !client || !active) {
      return;
    }
    let cancelled = false;
    const handle = setInterval(() => {
      void (async () => {
        let rttMs: number | null = null;
        try {
          ({ rttMs } = await client.ping({ timeoutMs: PING_INTERVAL_MS }));
        } catch {
          rttMs = null;
        }
        if (!cancelled) traceTerminalEvent({ ping: rttMs });
      })();
    }, PING_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [client, active]);
}
