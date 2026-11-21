import { randomUUID } from "node:crypto";
import type { SdkCredentialStore } from "@cursor/sdk";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";

interface CursorSdkAuth {
  Cursor: { auth: Pick<typeof import("@cursor/sdk").Cursor.auth, "login" | "status"> };
  FileCredentialStore: new () => SdkCredentialStore;
}
const loadCursorSdkAuth = () => import("@cursor/sdk");
const SIGN_IN_FAILED = "Cursor sign-in did not complete. Try again.";
const SIGN_IN_IN_PROGRESS = "Cursor sign-in is already in progress on this host.";
const SIGN_IN_UNAVAILABLE = "Cursor sign-in is unavailable on this host.";
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
  const record = await new FileCredentialStore().load();
  if (
    record?.backendUrl === cursorSdkBackendUrl() &&
    (record.apiKeyExpiresAtMs === undefined || record.apiKeyExpiresAtMs > Date.now())
  ) {
    return record.apiKey;
  }
  return undefined;
}

type AuthStatus = "signed_in" | "signed_out" | "api_key" | "pending";
interface Attempt {
  id: string;
  abort: AbortController;
  state: "pending" | "saving" | "failed" | "finished";
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

  constructor(
    private readonly hasEnvKey: () => boolean,
    private readonly onSignedIn: () => void,
    private readonly load: () => Promise<CursorSdkAuth> = loadCursorSdkAuth,
    private readonly timeoutMs = SIGN_IN_TIMEOUT_MS,
  ) {}

  async getStatus(attemptId?: string): Promise<{ status: AuthStatus; error: string | null }> {
    if (this.hasEnvKey()) return { status: "api_key", error: null };
    const attempt = this.attempt;
    if (attemptId && (attempt?.id !== attemptId || attempt.state === "failed")) {
      return { status: "signed_out", error: SIGN_IN_FAILED };
    }
    if (attempt && (attempt.state === "pending" || attempt.state === "saving")) {
      return { status: "pending", error: null };
    }
    try {
      const { Cursor } = await this.load();
      const status = await Cursor.auth.status();
      return {
        status:
          status.status === "logged-in" && status.backendUrl === cursorSdkBackendUrl()
            ? "signed_in"
            : "signed_out",
        error: null,
      };
    } catch {
      return { status: "signed_out", error: SIGN_IN_UNAVAILABLE };
    }
  }

  start(canSave: () => boolean): Promise<StartResult> {
    if (this.closed) return Promise.resolve(signInError(SIGN_IN_UNAVAILABLE));
    if (this.hasEnvKey()) {
      return Promise.resolve(signInError("Cursor SDK is configured with CURSOR_API_KEY."));
    }
    const active = this.attempt;
    if (active && (active.state === "pending" || active.state === "saving")) {
      return Promise.resolve(signInError(SIGN_IN_IN_PROGRESS));
    }

    const attempt: Attempt = { id: randomUUID(), abort: new AbortController(), state: "pending" };
    this.attempt = attempt;
    return new Promise<StartResult>((resolve) => {
      void this.runAttempt(attempt, canSave, resolve);
    });
  }

  private async runAttempt(
    attempt: Attempt,
    canSave: () => boolean,
    resolve: (result: StartResult) => void,
  ): Promise<void> {
    const signal = AbortSignal.any([attempt.abort.signal, AbortSignal.timeout(this.timeoutMs)]);
    const fail = () => {
      attempt.state = "failed";
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
          resolve({ attemptId: attempt.id, url, error: null });
        },
        store: {
          load: () => store.load(),
          clear: () => store.clear(),
          save: async (credentials) => {
            signal.throwIfAborted();
            if (!canSave() || this.hasEnvKey()) throw new Error("Cursor sign-in is unavailable");
            attempt.state = "saving";
            await store.save(credentials);
          },
        },
      });
      attempt.state = "finished";
      if (!this.closed) this.onSignedIn();
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

  close(): void {
    this.closed = true;
    this.attempt?.abort.abort();
  }
}
