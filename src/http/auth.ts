import type { RequestHandler } from "express";
import { API_CAPABILITIES, type ApiCapability, type ServiceAccountRole } from "../identity/apiCredentials.js";
import type { HumanSessionSourceCredentialType, HumanSessionStore } from "./humanSessions.js";

export interface AuthenticatedPrincipal {
  principalType: "agent" | "service_account";
  principalId: string;
  organizationId: string;
  credentialId: string;
  capabilities: ApiCapability[];
  role?: ServiceAccountRole;
  expiresAt?: string;
  sessionSourceCredentialId?: string;
  sessionSourceCredentialType?: HumanSessionSourceCredentialType;
}

export type CredentialAuthenticator = {
  authenticateToken(token: string, now: string): Promise<AuthenticatedPrincipal | null>;
  isCredentialActive?(
    organizationId: string,
    credentialId: string,
    credentialType: HumanSessionSourceCredentialType,
    now: string,
  ): Promise<boolean>;
};

export function createSessionAwareAuthenticator(
  credentials: CredentialAuthenticator,
  sessions: HumanSessionStore,
): CredentialAuthenticator {
  return {
    async authenticateToken(token, now) {
      if (!token.startsWith("fuse_hs_")) return credentials.authenticateToken(token, now);
      const session = await sessions.resolve(token, now);
      if (!session) return null;
      if (!credentials.isCredentialActive
        || !await credentials.isCredentialActive(
          session.workspaceId,
          session.sourceCredentialId,
          session.sourceCredentialType,
          now,
        )) return null;
      const role: ServiceAccountRole = session.role === "owner" ? "admin"
        : session.role === "member" ? "operator" : "viewer";
      const capabilities: ApiCapability[] = role === "admin" ? [...API_CAPABILITIES]
        : role === "operator"
          ? ["inference:invoke", "mandates:read", "mandates:write", "receipts:read", "policies:read", "providers:read", "sandbox:run"]
          : ["mandates:read", "receipts:read", "policies:read", "providers:read"];
      return {
        principalType: "service_account",
        principalId: session.userId,
        organizationId: session.workspaceId,
        credentialId: session.sessionId,
        capabilities,
        role,
        expiresAt: session.expiresAt,
        sessionSourceCredentialId: session.sourceCredentialId,
        sessionSourceCredentialType: session.sourceCredentialType,
      };
    },
  };
}

async function authenticatePrincipal(
  authenticator: CredentialAuthenticator,
  request: Parameters<RequestHandler>[0],
  response: Parameters<RequestHandler>[1],
  now: () => string,
): Promise<AuthenticatedPrincipal | null> {
  const existing = response.locals.fusePrincipal as AuthenticatedPrincipal | undefined;
  if (existing) return existing;
  const authorization = request.header("Authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.slice(7).trim() === "") {
    response.set("Cache-Control", "no-store");
    response.status(401).json({ error: { code: "AUTHENTICATION_REQUIRED" } });
    return null;
  }
  try {
    const principal = await authenticator.authenticateToken(authorization.slice(7).trim(), now());
    if (!principal) {
      response.set("Cache-Control", "no-store");
      response.status(401).json({ error: { code: "INVALID_CREDENTIAL" } });
      return null;
    }
    response.locals.fusePrincipal = principal;
    return principal;
  } catch {
    response.set("Cache-Control", "no-store");
    response.status(503).json({ error: { code: "AUTHENTICATION_UNAVAILABLE" } });
    return null;
  }
}

export function createAuthenticationGuard(
  authenticator: CredentialAuthenticator,
  now: () => string = () => new Date().toISOString(),
): RequestHandler {
  return async (request, response, next) => {
    if (await authenticatePrincipal(authenticator, request, response, now)) next();
  };
}

export function createCapabilityGuard(
  authenticator: CredentialAuthenticator,
  capability: ApiCapability,
  now: () => string = () => new Date().toISOString(),
): RequestHandler {
  return async (request, response, next) => {
    const principal = await authenticatePrincipal(authenticator, request, response, now);
    if (!principal) return;
    if (!principal.capabilities.includes(capability)) {
      response.set("Cache-Control", "no-store");
      response.status(403).json({ error: { code: "INSUFFICIENT_CAPABILITY" } });
      return;
    }
    next();
  };
}
