import { compare, hashSync } from "bcryptjs";
import type { RequestHandler } from "express";
import { matchesLocalCredential } from "./local-credential.js";

export const DAEMON_PASSWORD_BCRYPT_COST = 12;

export interface DaemonAuthConfig {
  password?: string;
  localCredential?: () => string | null;
}

export interface BearerAuthRejectContext {
  path: string;
  method: string;
  hasToken: boolean;
}

interface BearerValidationInput {
  password: string | undefined;
  token: string | null;
}

export async function isBearerTokenValidAsync(input: BearerValidationInput): Promise<boolean> {
  if (!input.password) {
    return true;
  }
  if (input.token === null) {
    return false;
  }

  return verifyDaemonPassword(input.token, input.password);
}

/** Thrown when too many password checks are already running or waiting. */
export class DaemonPasswordCheckBusyError extends Error {
  constructor() {
    super("Too many password checks in progress");
    this.name = "DaemonPasswordCheckBusyError";
  }
}

export interface PasswordCheckLimits {
  running: number;
  waiting: number;
}

/**
 * Bounds concurrent bcrypt compares. Each one costs about 250 ms of main-thread CPU at cost 12,
 * so unbounded checks from unauthenticated callers can starve the daemon.
 */
export function createPasswordCheckLimiter(
  limits: PasswordCheckLimits,
): (password: string, hash: string) => Promise<boolean> {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async (password, hash) => {
    if (running >= limits.running) {
      if (waiting.length >= limits.waiting) {
        throw new DaemonPasswordCheckBusyError();
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    running += 1;
    try {
      return await compare(password, hash);
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };
}

/** The daemon's one password check: HTTP bearer, WebSocket header and hello all share it. */
export const verifyDaemonPassword = createPasswordCheckLimiter({ running: 2, waiting: 16 });

export function hashDaemonPassword(password: string): string {
  return hashSync(password, DAEMON_PASSWORD_BCRYPT_COST);
}

export function extractHttpBearerToken(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const [scheme, ...tokenParts] = value.trim().split(/\s+/);
  if (scheme !== "Bearer" || tokenParts.length !== 1) {
    return null;
  }
  return tokenParts[0] ?? null;
}

export function extractWsBearerProtocol(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  for (const protocol of value.split(",")) {
    const trimmed = protocol.trim();
    const segments = trimmed.split(".");
    if (segments[0] === "paseo" && segments[1] === "bearer" && segments.length >= 3) {
      return trimmed;
    }
  }

  return null;
}

export function extractWsBearerToken(protocol: string | null): string | null {
  if (!protocol) {
    return null;
  }
  const segments = protocol.split(".");
  if (segments[0] !== "paseo" || segments[1] !== "bearer" || segments.length < 3) {
    return null;
  }
  return segments.slice(2).join(".");
}

export function createRequireBearerMiddleware(
  auth: DaemonAuthConfig | undefined,
  onReject?: (context: BearerAuthRejectContext) => void,
): RequestHandler {
  const password = auth?.password;
  return (req, res, next) => {
    if (!password || shouldBypassBearerAuth(req.method, req.path)) {
      next();
      return;
    }

    void (async () => {
      try {
        const token = extractHttpBearerToken(req.header("authorization"));
        const localCredential = req.path === "/api/status" ? auth?.localCredential?.() : null;
        const isLocal =
          localCredential !== null &&
          localCredential !== undefined &&
          token !== null &&
          matchesLocalCredential(localCredential, token);
        if (!isLocal && !(await isBearerTokenValidAsync({ password, token }))) {
          onReject?.({
            path: req.path,
            method: req.method,
            hasToken: token !== null,
          });
          res.status(401).json({ error: "Unauthorized" });
          return;
        }

        next();
      } catch (error) {
        if (error instanceof DaemonPasswordCheckBusyError) {
          res.status(429).json({ error: "Too many password checks" });
          return;
        }
        next(error);
      }
    })();
  };
}

const SELF_AUTHENTICATING_ROUTES = new Set(["/api/files/download"]);

function isBearerFreeRoute(path: string): boolean {
  return path === "/api/health" || SELF_AUTHENTICATING_ROUTES.has(path);
}

export function shouldBypassBearerAuth(method: string, path: string): boolean {
  if (method === "OPTIONS") {
    return true;
  }
  return isBearerFreeRoute(path);
}
