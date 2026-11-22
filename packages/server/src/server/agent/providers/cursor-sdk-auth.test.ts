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

function fixture(timeoutMs?: number, beforeSave?: Promise<void>) {
  let stored: StoredSdkCredentials | undefined;
  const allowMint = Promise.withResolvers<void>();
  const save = vi.fn(async (data: StoredSdkCredentials) => {
    await beforeSave;
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
  const logout = vi.fn(async () => new FileCredentialStore().clear());
  const sdk = {
    Cursor: {
      auth: {
        login,
        logout,
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
  return { allowMint, login, logout, save, sdk, service, signedIn };
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

it("lets another authorized view recover a pending attempt and cancel it", async () => {
  vi.stubEnv("CURSOR_API_KEY", "");
  const { service, allowMint, login, save } = fixture();
  const started = await service.start(() => true, "owner");
  expect(await service.getStatus()).toEqual({ status: "pending", error: null });
  const recovered = await service.getStatus(undefined, true);
  expect(recovered).toEqual({
    status: "pending",
    error: null,
    attempt: { id: started.attemptId, url: loginUrl },
  });
  expect(service.cancel(recovered.attempt!.id)).toEqual({ error: null });
  expect(await service.getStatus(undefined, true)).toEqual({ status: "signed_out", error: null });
  allowMint.resolve();
  await expect(login.mock.results[0].value).rejects.toThrow();
  expect(save).not.toHaveBeenCalled();
});

it("finishes saving if credential persistence won the cancel race", async () => {
  vi.stubEnv("CURSOR_API_KEY", "");
  const releaseSave = Promise.withResolvers<void>();
  const { service, allowMint, save, sdk, signedIn } = fixture(undefined, releaseSave.promise);
  const started = await service.start(() => true, "owner");
  allowMint.resolve();
  await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(await service.getStatus(undefined, true)).toEqual({ status: "pending", error: null });
  expect(service.cancel(started.attemptId!)).toEqual({ error: "Cursor sign-in is finishing." });
  expect(await service.signOut(() => true)).toEqual({ error: expect.any(String) });
  releaseSave.resolve();
  await vi.waitFor(() => expect(signedIn).toHaveBeenCalledOnce());
  await expect(readCursorSdkStoredKey(async () => sdk)).resolves.toBe(credential.apiKey);
});

it("aborts a pending attempt when its initiating principal loses access", async () => {
  vi.stubEnv("CURSOR_API_KEY", "");
  const { service, allowMint, login, save } = fixture();
  const started = await service.start(() => true, "initiating-principal");
  service.revokePrincipal("someone-else");
  expect(await service.getStatus(undefined, true)).toMatchObject({
    attempt: { id: started.attemptId },
  });
  service.revokePrincipal("initiating-principal");
  allowMint.resolve();
  await expect(login.mock.results[0].value).rejects.toThrow();
  expect(save).not.toHaveBeenCalled();
  expect(await service.getStatus(undefined, true)).toEqual({ status: "signed_out", error: null });
});

it("reports expiry and clears only the saved login, then allows reuse", async () => {
  vi.stubEnv("CURSOR_BACKEND_URL", credential.backendUrl);
  vi.stubEnv("CURSOR_API_KEY", "");
  const { service, logout, sdk, allowMint, signedIn } = fixture();
  const store = new sdk.FileCredentialStore();
  await store.save({ ...credential, apiKeyExpiresAtMs: 1 });
  expect(await service.getStatus(undefined, true)).toEqual({
    status: "signed_out",
    error: null,
    expired: true,
  });

  vi.stubEnv("CURSOR_API_KEY", "env-key");
  expect(await service.signOut(() => true)).toEqual({ error: expect.any(String) });
  expect(logout).not.toHaveBeenCalled();
  expect(await store.load()).toMatchObject({ apiKey: credential.apiKey });
  vi.stubEnv("CURSOR_API_KEY", "");
  expect(await service.signOut(() => false)).toEqual({ error: expect.any(String) });
  expect(logout).not.toHaveBeenCalled();
  expect(await service.signOut(() => true)).toEqual({ error: null });
  expect(await store.load()).toBeUndefined();
  expect(await service.getStatus(undefined, true)).toEqual({ status: "signed_out", error: null });

  expect(await service.start(() => true)).toMatchObject({ url: loginUrl });
  allowMint.resolve();
  await vi.waitFor(() => expect(signedIn).toHaveBeenCalled());
  await expect(readCursorSdkStoredKey(async () => sdk)).resolves.toBe(credential.apiKey);
});

it("lets a fresh view retry immediately after the originating route loses authority", async () => {
  vi.stubEnv("CURSOR_API_KEY", "");
  const { service, allowMint, login, save, signedIn } = fixture();
  const route = new AbortController();
  const abandoned = await service.start(() => true, "owner", route.signal);
  route.abort();
  expect(await service.getStatus(undefined, true)).toEqual({ status: "signed_out", error: null });
  const retry = await service.start(() => true, "owner");
  expect(retry.attemptId).not.toBe(abandoned.attemptId);
  expect(retry.url).toBe(loginUrl);
  allowMint.resolve();
  await expect(login.mock.results[0].value).rejects.toThrow();
  await vi.waitFor(() => expect(signedIn).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledOnce();
});
