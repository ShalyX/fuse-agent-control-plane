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

export function createCapabilityGuard(
  authenticator: CredentialAuthenticator,
  capability: ApiCapability,
  now: () => string = () => new Date().toISOString(),
): RequestHandler {
  return async (request, response, next) => {
    const authorization = request.header("Authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.slice(7).trim() === "") {
      response.set("Cache-Control", "no-store");
      response.status(401).json({ error: { code: "AUTHENTICATION_REQUIRED" } });
      return;
    }
    try {
      const principal = await authenticator.authenticateToken(authorization.slice(7).trim(), now());
      if (!principal) {
        response.set("Cache-Control", "no-store");
        response.status(401).json({ error: { code: "INVALID_CREDENTIAL" } });
        return;
      }
      if (!principal.capabilities.includes(capability)) {
        response.set("Cache-Control", "no-store");
        response.status(403).json({ error: { code: "INSUFFICIENT_CAPABILITY" } });
        return;
      }
      response.locals.fusePrincipal = principal;
      next();
    } catch {
      response.set("Cache-Control", "no-store");
      response.status(503).json({ error: { code: "AUTHENTICATION_UNAVAILABLE" } });
    }
  };
}
