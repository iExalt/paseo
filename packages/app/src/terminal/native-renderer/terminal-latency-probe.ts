import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { nativeTerminalPerformanceNow } from "./terminal-performance";
import { TERMINAL_TRACE_ENABLED, traceTerminalEvent } from "./terminal-input-trace";

// Dev-only: measures the scheduler floors that sit between receiving one
// echoed character and painting it, once per process, so a trace can tell a
// timer floor from parse or render work.

const PROBE_SAMPLES = 12;

type Scheduler = (callback: () => void) => void;

function measure(schedule: Scheduler): Promise<number> {
  const start = nativeTerminalPerformanceNow();
  return new Promise((resolve) => {
    schedule(() => resolve(nativeTerminalPerformanceNow() - start));
  });
}

async function sample(name: string, schedule: Scheduler): Promise<void> {
  const samples: number[] = [];
  for (let index = 0; index < PROBE_SAMPLES; index += 1) {
    samples.push(await measure(schedule));
  }
  samples.sort((left, right) => left - right);
  traceTerminalEvent({
    probe: name,
    p50: samples[Math.floor(samples.length / 2)],
    max: samples[samples.length - 1],
    samples: samples.map((value) => Math.round(value * 100) / 100),
  });
}

let probed = false;

export function probeTerminalSchedulerFloors(): void {
  if (!TERMINAL_TRACE_ENABLED || probed) {
    return;
  }
  probed = true;
  const terminal = new HeadlessTerminal({ rows: 24, cols: 80, allowProposedApi: true });
  void (async () => {
    await sample("microtask", (callback) => queueMicrotask(callback));
    await sample("setTimeout0", (callback) => setTimeout(callback, 0));
    if (typeof setImmediate === "function") {
      await sample("setImmediate", (callback) => setImmediate(callback));
    }
    await sample("rAF", (callback) => requestAnimationFrame(() => callback()));
    // xterm's WriteBuffer schedules the first write after idle with setTimeout.
    await sample("xtermWrite1", (callback) => terminal.write("x", callback));
    terminal.dispose();
  })();
}
