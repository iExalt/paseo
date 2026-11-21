import type { SdkCredentialStore, SdkLoginOptions, StoredSdkCredentials } from "@cursor/sdk";
import { afterEach, expect, it, vi } from "vitest";
import { CursorSdkSignIn, getCursorSdkEnvKey, readCursorSdkStoredKey } from "./cursor-sdk-auth.js";

const loginUrl = "https://cursor.com/loginDeepControl?challenge=public-challenge";
const credential: StoredSdkCredentials = {
  version: 1,
  backendUrl: "https://api2.cursor.sh",
  apiKey: "synthetic-private-key",
  createdAtMs: 1,
};

function fixture(timeoutMs?: number) {
  let stored: StoredSdkCredentials | undefined;
  const allowMint = Promise.withResolvers<void>();
  const save = vi.fn(async (data: StoredSdkCredentials) => {
    stored = data;
  });
  class FileCredentialStore implements SdkCredentialStore {
    async load() {
      return stored;
    }
    async clear() {
      stored = undefined;
    }
    save = save;
  }
  const login = vi.fn(async (options?: SdkLoginOptions) => {
    options?.onLoginUrl?.(loginUrl);
    await allowMint.promise;
    await options?.store?.save(credential);
    return { apiKey: credential.apiKey, apiKeyExpiresAtMs: 1 };
  });
  const sdk = {
    Cursor: {
      auth: {
        login,
        status: async () =>
          stored
            ? { status: "logged-in" as const, backendUrl: stored.backendUrl }
            : { status: "logged-out" as const },
      },
    },
    FileCredentialStore,
  };
  const signedIn = vi.fn();
  const service = new CursorSdkSignIn(
    () => !!getCursorSdkEnvKey(),
    signedIn,
    async () => sdk,
    timeoutMs,
  );
  return { allowMint, login, save, sdk, service, signedIn };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

it("exposes only the browser URL and attempt ID and reuses the native stored key", async () => {
  vi.stubEnv("CURSOR_API_KEY", "");
  vi.stubEnv("CURSOR_BACKEND_URL", "https://api2.cursor.sh/");
  const { service, allowMint, login, save, signedIn, sdk } = fixture();
  expect(await service.getStatus()).toEqual({ status: "signed_out", error: null });
  const attempt = await service.start(() => true);
  expect(attempt).toEqual({ attemptId: expect.any(String), url: loginUrl, error: null });
  expect(login).toHaveBeenCalledWith(
    expect.objectContaining({ openBrowser: false, signal: expect.any(AbortSignal) }),
  );
  expect(await service.getStatus(attempt.attemptId!)).toEqual({ status: "pending", error: null });
  expect(await service.start(() => true)).toMatchObject({
    attemptId: null,
    url: null,
    error: expect.any(String),
  });
  expect(service.cancel("different-attempt")).toEqual({ error: null });
  allowMint.resolve();
  await vi.waitFor(() => expect(signedIn).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledOnce();
  expect(await service.getStatus(attempt.attemptId!)).toEqual({ status: "signed_in", error: null });
  await expect(readCursorSdkStoredKey(async () => sdk)).resolves.toBe(credential.apiKey);
  vi.stubEnv("CURSOR_BACKEND_URL", "https://another-backend.invalid");
  await expect(readCursorSdkStoredKey(async () => sdk)).resolves.toBeUndefined();
  expect(await service.getStatus()).toEqual({ status: "signed_out", error: null });
});

it.each(["cancel", "timeout", "revocation"])(
  "prevents a late mint from writing after %s",
  async (reason) => {
    vi.stubEnv("CURSOR_API_KEY", "");
    const { allowMint, login, save, service, signedIn } = fixture(
      reason === "timeout" ? 5 : undefined,
    );
    let allowed = true;
    const { attemptId } = await service.start(() => allowed);
    if (reason === "cancel") service.cancel(attemptId!);
    if (reason === "timeout")
      await vi.waitFor(() => expect(login.mock.calls[0][0]?.signal?.aborted).toBe(true));
    if (reason === "revocation") allowed = false;
    allowMint.resolve();
    await expect(login.mock.results[0].value).rejects.toThrow();
    expect(await service.getStatus(attemptId!)).toEqual({
      status: "signed_out",
      error: expect.any(String),
    });
    expect(save).not.toHaveBeenCalled();
    expect(signedIn).not.toHaveBeenCalled();
  },
);

it("does not sign in when an environment key is configured", async () => {
  vi.stubEnv("CURSOR_API_KEY", "daemon-key");
  const { service, login } = fixture();
  expect(getCursorSdkEnvKey({ env: { CURSOR_API_KEY: "provider-key" } })).toBe("provider-key");
  expect(getCursorSdkEnvKey()).toBe("daemon-key");
  expect(getCursorSdkEnvKey({ env: { CURSOR_API_KEY: "" } })).toBeUndefined();
  expect(await service.getStatus()).toEqual({ status: "api_key", error: null });
  expect(await service.start(() => true)).toMatchObject({ attemptId: null, url: null });
  expect(login).not.toHaveBeenCalled();
});

it("ignores an expired stored credential", async () => {
  vi.stubEnv("CURSOR_BACKEND_URL", credential.backendUrl);
  const { sdk } = fixture();
  const store = new sdk.FileCredentialStore();
  await store.save({ ...credential, apiKeyExpiresAtMs: 1 });
  await expect(readCursorSdkStoredKey(async () => sdk)).resolves.toBeUndefined();
});
