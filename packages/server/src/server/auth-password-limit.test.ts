import { describe, expect, test, vi } from "vitest";

const pendingCompares: Array<(matches: boolean) => void> = [];
vi.mock("bcryptjs", () => ({
  compare: () => new Promise<boolean>((resolve) => pendingCompares.push(resolve)),
  hashSync: () => "hash",
}));

const { DaemonPasswordCheckBusyError, createPasswordCheckLimiter } = await import("./auth.js");

describe("password check limiter", () => {
  test("runs two bcrypt compares at a time, queues 16 and rejects the rest", async () => {
    const check = createPasswordCheckLimiter({ running: 2, waiting: 16 });
    const accepted = Array.from({ length: 18 }, () => check("guess", "hash"));
    await expect(check("guess", "hash")).rejects.toBeInstanceOf(DaemonPasswordCheckBusyError);
    expect(pendingCompares).toHaveLength(2);

    let settled = 0;
    while (settled < accepted.length) {
      const resolve = pendingCompares.shift();
      expect(resolve).toBeDefined();
      resolve!(true);
      settled += 1;
      await Promise.resolve();
      await Promise.resolve();
      expect(pendingCompares.length).toBeLessThanOrEqual(2);
    }
    await expect(Promise.all(accepted)).resolves.toEqual(Array(18).fill(true));
  });
});
