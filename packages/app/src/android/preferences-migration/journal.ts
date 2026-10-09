import { z } from "zod";

export const PREFERENCES_MIGRATION_JOURNAL_KEY = "@paseo:preferences-migration-journal:v1";
export const PREFERENCE_MIGRATION_KEYS = [
  "@paseo:app-settings",
  "@paseo:create-agent-preferences",
  "@paseo:changes-preferences",
  "@paseo:preferred-editor",
  "@paseo:keyboard-shortcut-overrides",
  "sidebar-view",
  "sidebar-project-workspace-order",
  "sidebar-collapsed-sections",
  "panel-state",
  "workspace-layout-state",
  "workspace-service-route-preferences",
] as const;

export interface PreferenceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  multiSet?(pairs: [string, string][]): Promise<void>;
}

const JournalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  phase: z.enum(["prepared", "applied"]),
  before: z
    .array(z.strictObject({ key: z.enum(PREFERENCE_MIGRATION_KEYS), value: z.string().nullable() }))
    .max(20),
  after: z
    .array(z.strictObject({ key: z.enum(PREFERENCE_MIGRATION_KEYS), value: z.string().nullable() }))
    .max(20),
});

type Journal = z.infer<typeof JournalSchema>;

function validateJournal(value: unknown): Journal {
  const journal = JournalSchema.parse(value);
  const beforeKeys = journal.before.map(({ key }) => key);
  const afterKeys = journal.after.map(({ key }) => key);
  if (
    new Set(beforeKeys).size !== beforeKeys.length ||
    new Set(afterKeys).size !== afterKeys.length ||
    beforeKeys.length !== afterKeys.length ||
    beforeKeys.some((key) => !afterKeys.includes(key))
  ) {
    throw new Error("Preference migration journal has inconsistent key lists.");
  }
  return journal;
}

async function writeValues(storage: PreferenceStorage, values: Journal["before"]): Promise<void> {
  const pairs = values.filter(
    (entry): entry is { key: Journal["before"][number]["key"]; value: string } =>
      entry.value !== null,
  );
  const removals = values.filter((entry) => entry.value === null);
  if (storage.multiSet && pairs.length > 0)
    await storage.multiSet(pairs.map(({ key, value }) => [key, value]));
  else for (const { key, value } of pairs) await storage.setItem(key, value);
  for (const { key } of removals) await storage.removeItem(key);
}

async function verifyValues(storage: PreferenceStorage, values: Journal["before"]): Promise<void> {
  for (const { key, value } of values) {
    if ((await storage.getItem(key)) !== value) {
      throw new Error(`Preference migration could not verify storage key ${key}.`);
    }
  }
}

/** Restores a pending import before app stores are allowed to hydrate. */
export async function recoverPreferencesMigration(storage: PreferenceStorage): Promise<boolean> {
  const serialized = await storage.getItem(PREFERENCES_MIGRATION_JOURNAL_KEY);
  if (serialized === null) return false;
  const journal = validateJournal(JSON.parse(serialized));
  await writeValues(storage, journal.before);
  await verifyValues(storage, journal.before);
  await storage.removeItem(PREFERENCES_MIGRATION_JOURNAL_KEY);
  return true;
}

/** Journals, applies, verifies, and reconciles selected keys as one recoverable operation. */
export async function applyPreferencesMigration(input: {
  storage: PreferenceStorage;
  after: Journal["after"];
  reconcile: () => Promise<void>;
}): Promise<void> {
  const { storage, after, reconcile } = input;
  if (await storage.getItem(PREFERENCES_MIGRATION_JOURNAL_KEY)) {
    throw new Error("A previous preference transfer needs recovery before another import.");
  }
  const before = await Promise.all(
    after.map(async ({ key }) => ({ key, value: await storage.getItem(key) })),
  );
  const journal = validateJournal({ schemaVersion: 1, phase: "prepared", before, after });
  await storage.setItem(PREFERENCES_MIGRATION_JOURNAL_KEY, JSON.stringify(journal));

  try {
    await writeValues(storage, after);
    await verifyValues(storage, after);
    await storage.setItem(
      PREFERENCES_MIGRATION_JOURNAL_KEY,
      JSON.stringify({ ...journal, phase: "applied" }),
    );
    await reconcile();
    await storage.removeItem(PREFERENCES_MIGRATION_JOURNAL_KEY);
  } catch (error) {
    try {
      await writeValues(storage, before);
      await verifyValues(storage, before);
      await reconcile();
      await storage.removeItem(PREFERENCES_MIGRATION_JOURNAL_KEY);
    } catch {
      // Keep the before-image journal so the next gated startup retries recovery.
    }
    throw error;
  }
}
