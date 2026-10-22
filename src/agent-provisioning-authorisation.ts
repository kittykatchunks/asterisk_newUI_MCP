import type { AccessResult, createAccessVerifier } from "./access.ts";
import { assertAgentIdentity, assertAgentProfile } from "./agent-directory.ts";
import type { AgentDirectory } from "./agent-directory.ts";
import type { AgentDeviceLeaseStore, AgentDeviceOwner } from "./agent-device-lease.ts";
import type { ApplicationSessionIdentity, createApplicationSessions } from "./application-session.ts";
import type { AgentProvisioningTransport } from "./agent-provisioning-dispatcher.ts";
import { AgentProvisioningConflict, parseProvisioningAcceptance } from "./agent-provisioning-store.ts";
import type { AgentProvisioningCommand, AgentProvisioningStore, ProvisioningContext, ProvisioningIntent, ProvisioningJournalBinding } from "./agent-provisioning-store.ts";

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

async function withLiveOwner<T>(
  command: AgentProvisioningCommand, owner: AgentDeviceOwner, extension: string,
  authorisation: Omit<ProvisioningAuthorisation, "resolve">, signal: AbortSignal,
  commit: (sessionExpiresAt: number) => T,
) {
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
  const session = checkSession();
  const profile = authorisation.agents.profile(owner.issuer, owner.subject, owner.customer);
  if (!profile) throw new AgentProvisioningConflict("Live provisioning assignment required");
  assertAgentProfile(profile);
  if (profile.extension !== extension) throw new AgentProvisioningConflict("Provisioning assignment changed");
  const sessionExpiresAt = Math.min(owner.sessionExpiresAt, session.expiresAt);
  const lease = authorisation.leases.current({ ...owner, sessionExpiresAt }, command.leaseId);
  if (command.notAfter > lease.expiresAt) throw new AgentProvisioningConflict("Provisioning deadline exceeds live lease");
  signal.throwIfAborted();
  // Do not yield between the final live checks and the enqueue/delivery call.
  return commit(sessionExpiresAt);
}

export function createSessionProvisioningProducer(input: {
  store: AgentProvisioningStore;
  sessions: Pick<ReturnType<typeof createApplicationSessions>, "lookupIdentity" | "verifyAgentAccess" | "authorisationReference">;
  verify: ReturnType<typeof createAccessVerifier>;
  agents: AgentDirectory;
  leases: AgentDeviceLeaseStore;
}) {
  const { store, sessions, verify, agents, leases } = input;
  return {
    async enqueue(commandInput: AgentProvisioningCommand, contextInput: ProvisioningContext,
      ownerInput: AgentDeviceOwner, signal: AbortSignal): Promise<ProvisioningIntent> {
      signal.throwIfAborted();
      const { command, context } = parseProvisioningAcceptance({ command: commandInput, context: contextInput });
      const owner = structuredClone(ownerInput);
      assertAgentIdentity(owner);
      if (command.action === "drain" || command.action === "revoke") {
        throw new AgentProvisioningConflict("Session producer cannot authorise trusted cleanup");
      }
      if (owner.customer !== command.customer) throw new AgentProvisioningConflict("Provisioning owner context mismatch");
      const profile = agents.profile(owner.issuer, owner.subject, owner.customer);
      if (!profile) throw new AgentProvisioningConflict("Live provisioning assignment required");
      assertAgentProfile(profile);
      const extension = profile.extension;
      if (command.action === "prepare" && command.payload.extension !== extension) {
        throw new AgentProvisioningConflict("Provisioning assignment changed");
      }
      return withLiveOwner(command, owner, extension, {
        session: sessions.lookupIdentity,
        agentAccess: (owner, signal) => sessions.verifyAgentAccess(owner, verify, signal),
        agents, leases,
      }, signal, (sessionExpiresAt) => {
        const authorisationId = sessions.authorisationReference(owner);
        if (!authorisationId) throw new AgentProvisioningConflict("Live provisioning session required");
        signal.throwIfAborted();
        return store.enqueueOwned(command, context, {
          issuer: owner.issuer, subject: owner.subject, customer: owner.customer, authorisationId,
          sessionExpiresAt, deviceId: owner.deviceId, generationId: command.payload.generationId, extension,
        });
      });
    },
  };
}

export function createSessionProvisioningAuthorisation(input: {
  store: AgentProvisioningStore;
  sessions: ReturnType<typeof createApplicationSessions>;
  verify: ReturnType<typeof createAccessVerifier>;
  agents: AgentDirectory;
  leases: AgentDeviceLeaseStore;
}): ProvisioningAuthorisation {
  const { store, sessions, verify, agents, leases } = input;
  return {
    resolve(intent) {
      const saved = store.operation(intent.command.customer, intent.command.operationId);
      if (!saved || saved.intent.sha256 !== intent.sha256 ||
          JSON.stringify(saved.intent.command) !== JSON.stringify(intent.command)) {
        throw new AgentProvisioningConflict("Provisioning ownership intent mismatch");
      }
      const recorded = store.ownership(intent.command.customer, intent.command.operationId);
      if (!recorded) return undefined;
      const session = sessions.resolveAuthorisation(recorded);
      if (!session) return undefined;
      return {
        owner: { issuer: recorded.issuer, subject: recorded.subject, customer: recorded.customer,
          sessionId: session.sessionId, sessionExpiresAt: recorded.sessionExpiresAt, deviceId: recorded.deviceId },
        generationId: recorded.generationId, extension: recorded.extension,
      };
    },
    session: sessions.lookupIdentity,
    agentAccess: (owner, signal) => sessions.verifyAgentAccess(owner, verify, signal),
    agents, leases,
  };
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
      return withLiveOwner(command, owner, extension, authorisation, signal,
        () => transport.accept(submission, signal));
    },
  };
}
