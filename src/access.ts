import { createRemoteJWKSet, jwtVerify } from "jose";

export type DiagnosticPermission = "diagnostics:read" | "diagnostics:report" | "diagnostics:review";

export interface Membership {
  issuer: string;
  subject: string;
  customer: string;
  permissions: readonly DiagnosticPermission[];
}

export interface SupportGrant extends Membership {
  startsAt: number;
  expiresAt: number;
  reason: string;
  contractReference: string;
}

export interface AccessConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  memberships: readonly Membership[];
  supportGrants: readonly SupportGrant[];
  allowLoopbackHttpForTests?: boolean;
}

export type AccessResult =
  | { allowed: true; subject: string; basis: "membership" | "support-grant" }
  | { allowed: false; status: 401 | 403 | 503; code: string };

function validateUrl(value: string, allowTestHttp: boolean): URL {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.username || url.password || url.hash ||
      (url.protocol !== "https:" && !(allowTestHttp && loopback && url.protocol === "http:"))) {
    throw new Error("Identity URLs must use HTTPS; loopback HTTP is test-only");
  }
  return url;
}

export function createAccessVerifier(config: AccessConfig) {
  validateUrl(config.issuer, config.allowLoopbackHttpForTests === true);
  const jwksUrl = validateUrl(config.jwksUrl, config.allowLoopbackHttpForTests === true);
  if (!config.audience.trim()) throw new Error("Access-token audience is required");
  // Provisioned grants, not caller-supplied token roles, define customer access.
  for (const membership of [...config.memberships, ...config.supportGrants]) {
    if (membership.issuer !== config.issuer || !membership.subject.trim() ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(membership.customer) ||
        membership.permissions.some((permission) =>
          permission !== "diagnostics:read" && permission !== "diagnostics:report" &&
          permission !== "diagnostics:review")) {
      throw new Error("Invalid provisioned customer membership");
    }
  }
  for (const grant of config.supportGrants) {
    if (!Number.isFinite(grant.startsAt) || !Number.isFinite(grant.expiresAt) ||
        grant.expiresAt <= grant.startsAt || !grant.reason.trim() || !grant.contractReference.trim()) {
      throw new Error("Support access requires a bounded interval, reason, and contract reference");
    }
  }
  // Copy configuration so later caller mutations cannot expand a running verifier.
  const memberships = structuredClone(config.memberships);
  const grants = structuredClone(config.supportGrants);
  const issuer = config.issuer;
  const audience = config.audience;
  const jwks = createRemoteJWKSet(jwksUrl, { timeoutDuration: 2000 });

  return async (
    authorization: string | undefined,
    customer: string,
    permission: DiagnosticPermission = "diagnostics:read",
  ): Promise<AccessResult> => {
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_.-]+)$/);
    if (!match) return { allowed: false, status: 401, code: "invalid_bearer_token" };
    let subject: string;
    try {
      const { payload } = await jwtVerify(match[1], jwks, {
        issuer, audience, algorithms: ["RS256"],
        requiredClaims: ["iss", "aud", "sub", "iat", "exp"],
        maxTokenAge: "15m",
      });
      if (!payload.sub?.trim()) return { allowed: false, status: 401, code: "invalid_bearer_token" };
      subject = payload.sub;
    } catch (error) {
      // Distinguish unavailable verification infrastructure from invalid credentials.
      if (error instanceof TypeError ||
          (error instanceof Error && ["ERR_JWKS_TIMEOUT"].includes(
            "code" in error ? String(error.code) : ""))) {
        return { allowed: false, status: 503, code: "identity_verification_unavailable" };
      }
      if (error instanceof Error && "code" in error &&
          /^(ERR_JWT_|ERR_JWS_|ERR_JOSE_|ERR_JWKS_)/.test(String(error.code))) {
        return { allowed: false, status: 401, code: "invalid_bearer_token" };
      }
      throw error;
    }
    const permits = (entry: Membership) => entry.subject === subject &&
      entry.customer === customer && entry.permissions.includes(permission);
    if (memberships.some(permits)) return { allowed: true, subject, basis: "membership" };
    const now = Date.now() / 1000;
    if (grants.some((grant) => permits(grant) && grant.startsAt <= now && now < grant.expiresAt)) {
      return { allowed: true, subject, basis: "support-grant" };
    }
    return { allowed: false, status: 403, code: "customer_access_denied" };
  };
}
