import type { RequestHandler } from "express";
import type { ApiCapability, ServiceAccountRole } from "../identity/apiCredentials.js";

export interface AuthenticatedPrincipal {
  principalType: "agent" | "service_account";
  principalId: string;
  organizationId: string;
  credentialId: string;
  capabilities: ApiCapability[];
  role?: ServiceAccountRole;
}

export interface CredentialAuthenticator {
  authenticateToken(token: string, now: string): Promise<AuthenticatedPrincipal | null>;
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
