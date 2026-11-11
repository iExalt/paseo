import type pino from "pino";
import { existsSync, readFileSync } from "node:fs";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

/**
 * Store for Expo push tokens.
 *
 * Tokens are persisted to disk so pushes still work after daemon restarts.
 */
export class PushTokenStore {
  private readonly logger: pino.Logger;
  private subscriptions = new Map<string, { expiresAt: number; registrationId?: string }>();
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly write: typeof writePrivateFileAtomicSync;

  constructor(
    logger: pino.Logger,
    filePath: string,
    now: () => number,
    leaseMs: number,
    write: typeof writePrivateFileAtomicSync = writePrivateFileAtomicSync,
  ) {
    this.logger = logger.child({ component: "token-store" });
    this.filePath = filePath;
    this.now = now;
    this.leaseMs = leaseMs;
    this.write = write;
    this.loadFromDisk();
  }

  renewToken(token: string, registrationId?: string | null): void {
    const normalized = token.trim();
    if (!normalized) return;
    const now = this.now();
    const current = this.subscriptions.get(normalized);
    const nextRegistration =
      registrationId === undefined ? current?.registrationId : (registrationId ?? undefined);
    if (
      current &&
      current.expiresAt - now > this.leaseMs / 2 &&
      current.registrationId === nextRegistration
    )
      return;
    const next = new Map(this.subscriptions);
    next.set(normalized, {
      expiresAt: now + this.leaseMs,
      ...(nextRegistration ? { registrationId: nextRegistration } : {}),
    });
    this.persist(next);
    this.subscriptions = next;
    this.logger.debug({ total: this.subscriptions.size }, "Renewed token");
  }

  revokeToken(token: string): void {
    const normalized = token.trim();
    if (!normalized) return;
    if (!this.subscriptions.has(normalized)) return;
    const next = new Map(this.subscriptions);
    next.delete(normalized);
    this.persist(next);
    this.subscriptions = next;
    this.logger.debug({ total: this.subscriptions.size }, "Revoked token");
  }

  getActiveTokens(): string[] {
    const now = this.now();
    const active = new Map(this.subscriptions);
    for (const [token, subscription] of this.subscriptions) {
      if (subscription.expiresAt <= now) {
        active.delete(token);
      }
    }
    if (active.size !== this.subscriptions.size) {
      try {
        this.persist(active);
        this.subscriptions = active;
      } catch {
        // Keep the previous state so a later send retries pruning. Expired tokens
        // are still excluded from this delivery.
      }
    }
    return Array.from(active.keys());
  }

  getActiveSubscriptions(): Array<{ token: string; registrationId?: string }> {
    return this.getActiveTokens().map((token) => {
      const registrationId = this.subscriptions.get(token)?.registrationId;
      return registrationId ? { token, registrationId } : { token };
    });
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.filePath)) {
        return;
      }
      ensurePrivateFile(this.filePath);
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as { subscriptions?: unknown; tokens?: unknown };
      const loaded = new Map<string, { expiresAt: number; registrationId?: string }>();
      const subscriptions = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
      for (const value of subscriptions) {
        if (!value || typeof value !== "object") continue;
        const candidate = value as {
          token?: unknown;
          expiresAt?: unknown;
          registrationId?: unknown;
        };
        if (typeof candidate.token !== "string" || typeof candidate.expiresAt !== "string")
          continue;
        const token = candidate.token.trim();
        const expiresAt = Date.parse(candidate.expiresAt);
        if (token && Number.isFinite(expiresAt)) {
          loaded.set(token, {
            expiresAt,
            ...(typeof candidate.registrationId === "string" &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              candidate.registrationId,
            )
              ? { registrationId: candidate.registrationId }
              : {}),
          });
        }
      }
      this.subscriptions = loaded;

      const legacyTokens = Array.isArray(parsed.tokens)
        ? parsed.tokens.filter((token): token is string => typeof token === "string")
        : [];
      if (legacyTokens.length > 0) {
        const migrated = new Map(loaded);
        const expiresAt = this.now() + this.leaseMs;
        for (const token of legacyTokens) {
          const normalized = token.trim();
          if (normalized) migrated.set(normalized, { expiresAt });
        }
        this.persist(migrated);
        this.subscriptions = migrated;
      }
      this.logger.info({ total: this.subscriptions.size }, "Loaded push tokens");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to load push tokens");
    }
  }

  private persist(
    subscriptions: ReadonlyMap<string, { expiresAt: number; registrationId?: string }>,
  ): void {
    try {
      const payload =
        JSON.stringify(
          {
            subscriptions: Array.from(subscriptions, ([token, subscription]) => ({
              token,
              expiresAt: new Date(subscription.expiresAt).toISOString(),
              ...(subscription.registrationId
                ? { registrationId: subscription.registrationId }
                : {}),
            })),
          },
          null,
          2,
        ) + "\n";
      this.write(this.filePath, payload);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to persist push tokens");
      throw err;
    }
  }
}
