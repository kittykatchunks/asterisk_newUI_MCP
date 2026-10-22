import type { AccessResult } from "./access.ts";
import { assertAgentIdentity, assertAgentProfile } from "./agent-directory.ts";
import type { AgentDirectory } from "./agent-directory.ts";
import type { AgentDeviceLeaseStore, AgentDeviceOwner } from "./agent-device-lease.ts";
import type { ApplicationSessionIdentity } from "./application-session.ts";
import type { AgentProvisioningTransport } from "./agent-provisioning-dispatcher.ts";
import { AgentProvisioningConflict, parseProvisioningAcceptance } from "./agent-provisioning-store.ts";
import type { ProvisioningIntent, ProvisioningJournalBinding } from "./agent-provisioning-store.ts";

export interface ProvisioningOwnerContext {
  owner: AgentDeviceOwner;
  generationId: string;
  extension: string;
}

export interface ProvisioningAuthorisation {
  // Resolve from protected backend state, never the command's actor/reason.
  resolve(intent: ProvisioningIntent): ProvisioningOwnerContext | undefined;
  session(owner: AgentDeviceOwner): ApplicationSessionIdentity | undefined;
  agentAccess(owner: AgentDeviceOwner, signal: AbortSignal): Promise<AccessResult>;
  agents: AgentDirectory;
  leases: AgentDeviceLeaseStore;
}

export function createAuthorisedProvisioningTransport(
  transport: AgentProvisioningTransport, input: ProvisioningJournalBinding,
  authorisation: ProvisioningAuthorisation,
): AgentProvisioningTransport {
  const binding = { ...input };
  if (typeof binding.customer !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(binding.customer) ||
      typeof binding.epoch !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(binding.epoch)) {
    throw new Error("Invalid provisioning authorisation binding");
  }
  return {
    report(id, signal) { return transport.report(id, signal); },
    async accept(intent, signal) {
      signal.throwIfAborted();
      // Detach before awaits so callers cannot change the command or its resolved owner.
      const submission = structuredClone(intent);
      const parsed = parseProvisioningAcceptance({ command: submission.command, context: submission.context });
      submission.command = parsed.command;
      const command = submission.command;
      if (command.customer !== binding.customer || command.epoch !== binding.epoch) {
        throw new AgentProvisioningConflict("Provisioning authorisation scope mismatch");
      }
      if (command.action === "drain" || command.action === "revoke") {
        return transport.accept(submission, signal);
      }
      const resolved = authorisation.resolve(structuredClone(submission));
      if (!resolved) throw new AgentProvisioningConflict("Provisioning owner context missing");
      const { owner, generationId, extension } = structuredClone(resolved);
      assertAgentIdentity(owner);
      if (owner.customer !== command.customer || generationId !== command.payload.generationId ||
          !/^[0-9]{1,16}$/.test(extension) ||
          (command.action === "prepare" && extension !== command.payload.extension)) {
        throw new AgentProvisioningConflict("Provisioning owner context mismatch");
      }
      const checkSession = () => {
        const session = authorisation.session({ ...owner });
        if (!session || session.sessionId !== owner.sessionId || session.subject !== owner.subject ||
            session.customer !== owner.customer || !Number.isSafeInteger(session.expiresAt) ||
            session.expiresAt <= 0) throw new AgentProvisioningConflict("Live provisioning session required");
        return session;
      };
      checkSession();
      const access = await authorisation.agentAccess({ ...owner }, signal);
      signal.throwIfAborted();
      if (!access.allowed || access.basis !== "membership" || access.subject !== owner.subject) {
        throw new AgentProvisioningConflict("Direct provisioning agent membership required");
      }
      // Logout, assignment removal and lease release can happen while access verification yields.
      const session = checkSession();
      const profile = authorisation.agents.profile(owner.issuer, owner.subject, owner.customer);
      if (!profile) throw new AgentProvisioningConflict("Live provisioning assignment required");
      assertAgentProfile(profile);
      if (profile.extension !== extension) throw new AgentProvisioningConflict("Provisioning assignment changed");
      const lease = authorisation.leases.current({
        ...owner, sessionExpiresAt: Math.min(owner.sessionExpiresAt, session.expiresAt),
      }, command.leaseId);
      if (command.notAfter > lease.expiresAt) {
        throw new AgentProvisioningConflict("Provisioning deadline exceeds live lease");
      }
      signal.throwIfAborted();
      return transport.accept(submission, signal);
    },
  };
}
