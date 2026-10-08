import { compare, hashSync } from "bcryptjs";
import type { RequestHandler } from "express";
import { OWNER_PERMISSIONS, type DaemonPermission } from "./authorization/index.js";
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

  return compare(input.token, input.password);
}

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
        next(error);
      }
    })();
  };
}

const SELF_AUTHENTICATING_ROUTES = new Set(["/api/files/download", "/mcp/agents"]);

function isBearerFreeRoute(path: string): boolean {
  return path === "/api/health" || SELF_AUTHENTICATING_ROUTES.has(path);
}

export function shouldBypassBearerAuth(method: string, path: string): boolean {
  if (method === "OPTIONS") {
    return true;
  }
  return isBearerFreeRoute(path);
}

/**
 * Authorizes a request to the Agent MCP endpoint (/mcp/agents), which is exempt
 * from the global daemon-password middleware. Accepts either the per-daemon-run
 * capability token the daemon injects into its own agents' configs and MCP
 * client, or a valid daemon-password bearer (so existing password-authenticated
 * callers keep working). When no daemon password is configured the endpoint is
 * open, matching the global middleware's behavior.
 */
export async function isAgentMcpRequestAuthorized(input: {
  password: string | undefined;
  capabilityToken: string | null;
  authorizationHeader: string | undefined;
}): Promise<boolean> {
  const admission = await resolveAgentMcpRequestAdmission({
    password: input.password,
    capabilityToken: input.capabilityToken,
    localCredential: null,
    authorizationHeader: input.authorizationHeader,
  });
  return admission.kind !== "rejected";
}

export type AgentMcpRequestAdmission =
  | { kind: "agent-capability" | "anonymous"; permissions: readonly [] }
  | {
      kind: "local-owner" | "password-owner";
      permissions: readonly DaemonPermission[];
    }
  | { kind: "rejected"; permissions: readonly [] };

/**
 * Classifies /mcp/agents credentials separately from session admission. The
 * injected agent capability authenticates control-plane access but never grants
 * daemon host permissions. Anonymous access remains available without a daemon
 * password, also without host permissions.
 */
export async function resolveAgentMcpRequestAdmission(input: {
  password: string | undefined;
  capabilityToken: string | null;
  localCredential: string | null;
  authorizationHeader: string | undefined;
}): Promise<AgentMcpRequestAdmission> {
  const token = extractHttpBearerToken(input.authorizationHeader);

  // The injected per-run token authenticates an agent before any owner
  // credential checks, in both password modes, and never implies host access.
  if (
    input.capabilityToken !== null &&
    token !== null &&
    matchesLocalCredential(input.capabilityToken, token)
  ) {
    return { kind: "agent-capability", permissions: [] };
  }

  if (
    input.localCredential !== null &&
    token !== null &&
    matchesLocalCredential(input.localCredential, token)
  ) {
    return { kind: "local-owner", permissions: OWNER_PERMISSIONS };
  }

  if (input.password) {
    return (await isBearerTokenValidAsync({ password: input.password, token }))
      ? { kind: "password-owner", permissions: OWNER_PERMISSIONS }
      : { kind: "rejected", permissions: [] };
  }

  return { kind: "anonymous", permissions: [] };
}
