import { describe, expect, it } from "vitest";
import {
  applyPreferencesMigration,
  PREFERENCES_MIGRATION_JOURNAL_KEY,
  recoverPreferencesMigration,
  type PreferenceStorage,
} from "./journal";

class MemoryStorage implements PreferenceStorage {
  readonly values = new Map<string, string>();
  failNextSetFor: string | null = null;

  async getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string) {
    if (this.failNextSetFor === key) {
      this.failNextSetFor = null;
      throw new Error("injected storage failure");
    }
    this.values.set(key, value);
  }

  async removeItem(key: string) {
    this.values.delete(key);
  }

  async multiSet(pairs: [string, string][]) {
    for (const [key, value] of pairs) await this.setItem(key, value);
  }
}

describe("preference transfer recovery journal", () => {
  it("rejects an unknown journal key before it can touch non-preference storage", async () => {
    const storage = new MemoryStorage();
    storage.values.set(
      PREFERENCES_MIGRATION_JOURNAL_KEY,
      JSON.stringify({
        schemaVersion: 1,
        phase: "prepared",
        before: [{ key: "@paseo:daemon-registry", value: "sensitive" }],
        after: [{ key: "@paseo:daemon-registry", value: "attacker" }],
      }),
    );

    await expect(recoverPreferencesMigration(storage)).rejects.toThrow();
    expect(await storage.getItem("@paseo:daemon-registry")).toBeNull();
  });

  it("restores before-images when live-store reconciliation fails", async () => {
    const storage = new MemoryStorage();
    storage.values.set("@paseo:app-settings", '{"theme":"dark"}');

    let reconcileCalls = 0;
    await expect(
      applyPreferencesMigration({
        storage,
        after: [{ key: "@paseo:app-settings", value: '{"theme":"light"}' }],
        reconcile: async () => {
          reconcileCalls += 1;
          if (reconcileCalls === 1) throw new Error("injected reconciliation failure");
        },
      }),
    ).rejects.toThrow("injected reconciliation failure");

    expect(await storage.getItem("@paseo:app-settings")).toBe('{"theme":"dark"}');
    expect(await storage.getItem(PREFERENCES_MIGRATION_JOURNAL_KEY)).toBeNull();
  });

  it("retains the journal when restoring fails so gated startup can recover it", async () => {
    const storage = new MemoryStorage();
    storage.values.set("@paseo:app-settings", '{"theme":"dark"}');
    let reconciliationCalls = 0;
    await expect(
      applyPreferencesMigration({
        storage,
        after: [{ key: "@paseo:app-settings", value: '{"theme":"light"}' }],
        reconcile: async () => {
          reconciliationCalls += 1;
          if (reconciliationCalls === 1) {
            storage.failNextSetFor = "@paseo:app-settings";
            throw new Error("refresh failed");
          }
        },
      }),
    ).rejects.toThrow("refresh failed");

    expect(await storage.getItem(PREFERENCES_MIGRATION_JOURNAL_KEY)).not.toBeNull();
    storage.failNextSetFor = null;
    await expect(recoverPreferencesMigration(storage)).resolves.toBe(true);
    expect(await storage.getItem("@paseo:app-settings")).toBe('{"theme":"dark"}');
  });
});
