export interface AgentAssignment {
  issuer: string;
  subject: string;
  customer: string;
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

export function createAgentDirectory(assignments: readonly AgentAssignment[]): AgentDirectory {
  const identities = new Set<string>();
  const entries = assignments.map((assignment) => {
    const identity = JSON.stringify([assignment.issuer, assignment.subject, assignment.customer]);
    const url = new URL(assignment.issuer);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash ||
        typeof assignment.subject !== "string" || !assignment.subject.trim() || assignment.subject.length > 200 ||
        /[\x00-\x1f\x7f]/.test(assignment.subject) ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(assignment.customer) ||
        typeof assignment.extension !== "string" || !/^[0-9]{1,16}$/.test(assignment.extension) ||
        typeof assignment.displayName !== "string" || !assignment.displayName.trim() || assignment.displayName.length > 128 ||
        /[\x00-\x1f\x7f]/.test(assignment.displayName) || identities.has(identity)) {
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
