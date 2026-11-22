import { randomUUID } from "node:crypto";
import type { SdkCredentialStore, StoredSdkCredentials } from "@cursor/sdk";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";

interface CursorSdkAuth {
  Cursor: { auth: Pick<typeof import("@cursor/sdk").Cursor.auth, "login" | "logout"> };
  FileCredentialStore: new () => SdkCredentialStore;
}
const loadCursorSdkAuth = () => import("@cursor/sdk");
const SIGN_IN_FAILED = "Cursor sign-in did not complete. Try again.";
const SIGN_IN_IN_PROGRESS = "Cursor sign-in is already in progress on this host.";
const SIGN_IN_UNAVAILABLE = "Cursor sign-in is unavailable on this host.";
const ENV_KEY_CONFIGURED = "Cursor SDK is configured with CURSOR_API_KEY.";
const SIGN_OUT_FAILED = "Could not sign out of Cursor SDK on this host.";
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

export const CURSOR_SDK_PROVIDER = "cursor-sdk";

export function getCursorSdkEnvKey(settings?: ProviderRuntimeSettings): string | undefined {
  const key = settings?.env?.CURSOR_API_KEY ?? process.env.CURSOR_API_KEY;
  return key?.trim() || undefined;
}

function cursorSdkBackendUrl(): string {
  // Cursor SDK 1.4.2 pairs a stored key with its auth backend, including this default.
  return (process.env.CURSOR_BACKEND_URL ?? "https://api2.cursor.sh").replace(/\/+$/, "");
}

export async function readCursorSdkStoredKey(
  load: () => Promise<Pick<CursorSdkAuth, "FileCredentialStore">> = loadCursorSdkAuth,
): Promise<string | undefined> {
  const { FileCredentialStore } = await load();
  const record = await loadBackendCredentials(new FileCredentialStore());
  return record && !isExpired(record) ? record.apiKey : undefined;
}

async function loadBackendCredentials(store: SdkCredentialStore) {
  const record = await store.load();
  return record?.backendUrl === cursorSdkBackendUrl() ? record : undefined;
}

function isExpired(record: StoredSdkCredentials): boolean {
  return record.apiKeyExpiresAtMs !== undefined && record.apiKeyExpiresAtMs <= Date.now();
}

type AuthStatus = "signed_in" | "signed_out" | "api_key" | "pending";
interface Attempt {
  id: string;
  abort: AbortController;
  principalId?: string;
  url: string | null;
  state: "pending" | "saving" | "failed" | "finished";
}

interface StatusResult {
  status: AuthStatus;
  error: string | null;
  attempt?: { id: string; url: string | null };
  expired?: true;
}

interface StartResult {
  attemptId: string | null;
  url: string | null;
  error: string | null;
}

function signInError(error: string): StartResult {
  return { attemptId: null, url: null, error };
}

export class CursorSdkSignIn {
  private attempt?: Attempt;
  private closed = false;
  private signingOut = false;

  constructor(
    private readonly hasEnvKey: () => boolean,
    private readonly onCredentialsChanged: () => void,
    private readonly load: () => Promise<CursorSdkAuth> = loadCursorSdkAuth,
    private readonly timeoutMs = SIGN_IN_TIMEOUT_MS,
  ) {}

  async getStatus(attemptId?: string, includeDetails = false): Promise<StatusResult> {
    if (this.hasEnvKey()) return { status: "api_key", error: null };
    const attempt = this.attempt;
    if (attemptId && (attempt?.id !== attemptId || attempt.state === "failed")) {
      return { status: "signed_out", error: SIGN_IN_FAILED };
    }
    if (attempt?.state === "pending") {
      return {
        status: "pending",
        error: null,
        ...(includeDetails ? { attempt: { id: attempt.id, url: attempt.url } } : {}),
      };
    }
    if (attempt?.state === "saving") return { status: "pending", error: null };
    try {
      const { FileCredentialStore } = await this.load();
      const record = await loadBackendCredentials(new FileCredentialStore());
      const expired = record !== undefined && isExpired(record);
      return {
        status: record && !expired ? "signed_in" : "signed_out",
        error: null,
        ...(includeDetails && expired ? { expired: true } : {}),
      };
    } catch {
      return { status: "signed_out", error: SIGN_IN_UNAVAILABLE };
    }
  }

  start(
    canSave: () => boolean,
    principalId?: string,
    sessionSignal?: AbortSignal,
  ): Promise<StartResult> {
    if (this.closed || this.signingOut || sessionSignal?.aborted) {
      return Promise.resolve(signInError(SIGN_IN_UNAVAILABLE));
    }
    if (this.hasEnvKey()) {
      return Promise.resolve(signInError(ENV_KEY_CONFIGURED));
    }
    const active = this.attempt;
    if (active && (active.state === "pending" || active.state === "saving")) {
      return Promise.resolve(signInError(SIGN_IN_IN_PROGRESS));
    }

    const attempt: Attempt = {
      id: randomUUID(),
      abort: new AbortController(),
      principalId,
      url: null,
      state: "pending",
    };
    this.attempt = attempt;
    return new Promise<StartResult>((resolve) => {
      void this.runAttempt(attempt, canSave, resolve, sessionSignal);
    });
  }

  private async runAttempt(
    attempt: Attempt,
    canSave: () => boolean,
    resolve: (result: StartResult) => void,
    sessionSignal?: AbortSignal,
  ): Promise<void> {
    const signal = AbortSignal.any([
      attempt.abort.signal,
      AbortSignal.timeout(this.timeoutMs),
      ...(sessionSignal ? [sessionSignal] : []),
    ]);
    const fail = () => {
      attempt.state = "failed";
      attempt.url = null;
      resolve(signInError(SIGN_IN_FAILED));
    };
    const onAbort = () => {
      if (attempt.state === "pending") fail();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const { Cursor, FileCredentialStore } = await this.load();
      signal.throwIfAborted();
      const store = new FileCredentialStore();
      await Cursor.auth.login({
        openBrowser: false,
        signal,
        onLoginUrl: (url) => {
          signal.throwIfAborted();
          const parsed = new URL(url);
          if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
            throw new Error("Invalid Cursor sign-in URL");
          }
          attempt.url = parsed.href;
          resolve({ attemptId: attempt.id, url: attempt.url, error: null });
        },
        store: {
          load: () => store.load(),
          clear: () => store.clear(),
          save: async (credentials) => {
            signal.throwIfAborted();
            if (this.attempt !== attempt || !canSave() || this.hasEnvKey()) {
              throw new Error(SIGN_IN_UNAVAILABLE);
            }
            attempt.state = "saving";
            attempt.url = null;
            await store.save(credentials);
          },
        },
      });
      attempt.state = "finished";
      if (!this.closed) this.onCredentialsChanged();
    } catch {
      fail();
    } finally {
      signal.removeEventListener("abort", onAbort);
      resolve(signInError(SIGN_IN_FAILED));
    }
  }

  cancel(attemptId: string): { error: string | null } {
    const attempt = this.attempt;
    if (attempt?.id === attemptId) {
      if (attempt.state === "saving") return { error: "Cursor sign-in is finishing." };
      if (attempt.state === "pending") attempt.abort.abort();
    }
    return { error: null };
  }

  revokePrincipal(principalId: string): void {
    const attempt = this.attempt;
    if (attempt?.principalId === principalId && attempt.state === "pending") {
      attempt.abort.abort();
    }
  }

  async signOut(canClear: () => boolean): Promise<{ error: string | null }> {
    if (this.hasEnvKey()) return { error: ENV_KEY_CONFIGURED };
    if (this.attempt?.state === "pending" || this.attempt?.state === "saving") {
      return { error: SIGN_IN_IN_PROGRESS };
    }
    if (this.closed || this.signingOut) return { error: SIGN_OUT_FAILED };

    this.signingOut = true;
    try {
      const { Cursor, FileCredentialStore } = await this.load();
      const store = new FileCredentialStore();
      const record = await loadBackendCredentials(store);
      if (this.closed || !canClear() || this.hasEnvKey()) return { error: SIGN_OUT_FAILED };
      if (record) await Cursor.auth.logout({ store });
      this.attempt = undefined;
      this.onCredentialsChanged();
      return { error: null };
    } catch {
      return { error: SIGN_OUT_FAILED };
    } finally {
      this.signingOut = false;
    }
  }

  close(): void {
    this.closed = true;
    this.attempt?.abort.abort();
  }
}
