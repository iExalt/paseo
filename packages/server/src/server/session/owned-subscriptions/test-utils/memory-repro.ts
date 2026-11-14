import { AsyncLocalStorage } from "node:async_hooks";
import { SessionDelivery } from "../index.js";

const cycles = Number(process.argv[2]);
const leak = process.argv[3] === "leak";
const count = 4096;
for (let index = 0; index <= cycles; index++) {
  const delivery = new SessionDelivery(() => {});
  const source = {};
  delivery.attach(source, true);
  delivery.forSource(source, () => {});
  await delivery.request(source, { type: "ping", requestId: String(index) }, async () => {});
  await delivery.close();
  if (leak) {
    // The historical delivery created two async-hook registrations that close never disabled.
    new AsyncLocalStorage().run({}, () => {});
    await new AsyncLocalStorage().run({}, async () => {});
  }
}

if (!global.gc) throw new Error("Run with --expose-gc");
const gc = global.gc;
function retainedPromiseBytes(): number {
  gc();
  const before = process.memoryUsage().heapUsed;
  const held = Array.from({ length: count }, () => new Promise<void>(() => {}));
  gc();
  const retainedBytes = process.memoryUsage().heapUsed - before;
  if (held.length !== count) throw new Error("Promise allocation failed");
  return retainedBytes;
}

// Warm allocation and collection before measuring the same retained objects in each process.
retainedPromiseBytes();
const samples = Array.from({ length: 3 }, retainedPromiseBytes);
process.stdout.write(JSON.stringify(samples));
