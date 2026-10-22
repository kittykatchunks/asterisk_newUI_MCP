export interface AgentIdentity {
  issuer: string;
  subject: string;
  customer: string;
}

export interface AgentAssignment extends AgentIdentity {
  extension: string;
  displayName: string;
}

export interface AgentProfile {
  extension: string;
  displayName: string;
}

export interface AgentDirectory {
  profile(issuer: string, subject: string, customer: string): AgentProfile | undefined;
}

export function assertAgentIdentity(value: unknown): asserts value is AgentIdentity {
  if (typeof value !== "object" || value === null ||
      !("issuer" in value) || typeof value.issuer !== "string" ||
      !("subject" in value) || typeof value.subject !== "string" ||
      !("customer" in value) || typeof value.customer !== "string") {
    throw new Error("Invalid agent identity");
  }
  const url = new URL(value.issuer);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash ||
      !value.subject.trim() || value.subject.length > 200 || /[\x00-\x1f\x7f]/.test(value.subject) ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.customer)) {
    throw new Error("Invalid agent identity");
  }
}

export function assertAgentAssignment(value: unknown): asserts value is AgentAssignment {
  if (typeof value !== "object" || value === null ||
      !("issuer" in value) || typeof value.issuer !== "string" ||
      !("subject" in value) || typeof value.subject !== "string" ||
      !("customer" in value) || typeof value.customer !== "string" ||
      !("extension" in value) || typeof value.extension !== "string" ||
      !("displayName" in value) || typeof value.displayName !== "string") {
    throw new Error("Invalid provisioned agent assignment");
  }
  assertAgentIdentity(value);
  if (!/^[0-9]{1,16}$/.test(value.extension) ||
      !value.displayName.trim() || value.displayName.length > 128 || /[\x00-\x1f\x7f]/.test(value.displayName)) {
    throw new Error("Invalid provisioned agent assignment");
  }
}

export function createAgentDirectory(assignments: readonly AgentAssignment[]): AgentDirectory {
  const identities = new Set<string>();
  const entries = assignments.map((assignment) => {
    assertAgentAssignment(assignment);
    const identity = JSON.stringify([assignment.issuer, assignment.subject, assignment.customer]);
    if (identities.has(identity)) {
      throw new Error("Invalid or duplicate provisioned agent assignment");
    }
    identities.add(identity);
    return { ...assignment };
  });
  return {
    profile(issuer, subject, customer) {
      const entry = entries.find((item) => item.issuer === issuer && item.subject === subject && item.customer === customer);
      return entry ? { extension: entry.extension, displayName: entry.displayName } : undefined;
    },
  };
}
