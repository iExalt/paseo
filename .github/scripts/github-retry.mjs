import { setTimeout as sleep } from "node:timers/promises";

// GitHub intermittently answers valid reads with 5xx. Only idempotent reads are
// retried, a bounded number of times; callers still check every response.
const delays = [2000, 5000];
let pause = sleep;
let pauseSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Tests substitute instant pauses; production always waits.
export function replaceRetryPause(wait, waitSync) {
  const previous = [pause, pauseSync];
  [pause, pauseSync] = [wait, waitSync];
  return () => {
    [pause, pauseSync] = previous;
  };
}

export function retryingFetch(request) {
  return async (url, options = {}) => {
    if ((options.method ?? "GET").toUpperCase() !== "GET") return request(url, options);
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await request(url, options);
      } catch (error) {
        if (attempt >= delays.length || options.signal?.aborted) throw error;
        await pause(delays[attempt]);
        continue;
      }
      if (response.status < 500 || attempt >= delays.length) return response;
      await response.body?.cancel();
      await pause(delays[attempt]);
    }
  };
}

function transientGh(error) {
  return /\bHTTP 5\d\d\b/.test(String(error.stderr ?? "")) || error.code === "ETIMEDOUT";
}

// For synchronous `gh api` GET reads, which fail with the status on stderr.
export function retryingGhRead(read) {
  return (...args) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return read(...args);
      } catch (error) {
        if (attempt >= delays.length || !transientGh(error)) throw error;
        pauseSync(delays[attempt]);
      }
    }
  };
}
