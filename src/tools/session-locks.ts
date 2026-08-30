import {
  type AdvisoryLockListValue,
  type AdvisoryLockMutationValue,
  type AdvisoryLockUseCasePorts,
  listAdvisoryLocks,
  publishAdvisoryLock,
  releaseAdvisoryLock,
  renewAdvisoryLock,
} from "../application/advisory-lock-use-cases";
import type { FencingToken } from "../domain/ownership";
import type { WorkspaceKey } from "../domain/workspaces";
import {
  type InternalToolContract,
  type SessionLockListToolArguments,
  type SessionLockPublishToolArguments,
  type SessionLockReleaseToolArguments,
  type SessionLockRenewToolArguments,
  serializeDomainResult,
  sessionLockListArgumentsSchema,
  sessionLockListFailureCodes,
  sessionLockOwnedMutationFailureCodes,
  sessionLockPublishArgumentsSchema,
  sessionLockPublishFailureCodes,
  sessionLockReleaseArgumentsSchema,
  sessionLockRenewArgumentsSchema,
} from "./contracts";
import { publicAdvisoryLockList, publicAdvisoryLockMutation } from "./public-values";

interface LockToolScope {
  readonly workspaceKey: WorkspaceKey;
  readonly fencingToken: FencingToken;
}

export function createSessionLockListTool(
  ports: AdvisoryLockUseCasePorts,
  scope: LockToolScope,
): InternalToolContract<SessionLockListToolArguments> {
  return {
    description: "List active advisory locks in this workspace using an opaque keyset cursor.",
    args: sessionLockListArgumentsSchema,
    async execute(arguments_, context) {
      const result = await listAdvisoryLocks(
        ports,
        { ...scope, callerSessionId: context.sessionID },
        arguments_,
      );
      return serializeDomainResult<AdvisoryLockListValue, Record<string, unknown>>(
        result,
        publicAdvisoryLockList,
        sessionLockListFailureCodes,
      );
    },
  };
}

export function createSessionLockPublishTool(
  ports: AdvisoryLockUseCasePorts,
  scope: LockToolScope,
): InternalToolContract<SessionLockPublishToolArguments> {
  return {
    description: "Publish a time-bounded advisory lock held by the current visible root session.",
    args: sessionLockPublishArgumentsSchema,
    async execute(arguments_, context) {
      const result = await publishAdvisoryLock(
        ports,
        { ...scope, callerSessionId: context.sessionID },
        {
          ttlSeconds: arguments_.ttl_seconds,
          title: arguments_.title,
          description: arguments_.description,
          instructions: arguments_.instructions,
        },
      );
      return serializeDomainResult<AdvisoryLockMutationValue, Record<string, unknown>>(
        result,
        publicAdvisoryLockMutation,
        sessionLockPublishFailureCodes,
      );
    },
  };
}

export function createSessionLockReleaseTool(
  ports: AdvisoryLockUseCasePorts,
  scope: LockToolScope,
): InternalToolContract<SessionLockReleaseToolArguments> {
  return {
    description: "Release an advisory lock held by the current visible root session.",
    args: sessionLockReleaseArgumentsSchema,
    async execute(arguments_, context) {
      const result = await releaseAdvisoryLock(
        ports,
        { ...scope, callerSessionId: context.sessionID },
        { lockId: arguments_.lock_id },
      );
      return serializeDomainResult<AdvisoryLockMutationValue, Record<string, unknown>>(
        result,
        publicAdvisoryLockMutation,
        sessionLockOwnedMutationFailureCodes,
      );
    },
  };
}

export function createSessionLockRenewTool(
  ports: AdvisoryLockUseCasePorts,
  scope: LockToolScope,
): InternalToolContract<SessionLockRenewToolArguments> {
  return {
    description: "Renew an advisory lock held by the current visible root session.",
    args: sessionLockRenewArgumentsSchema,
    async execute(arguments_, context) {
      const result = await renewAdvisoryLock(
        ports,
        { ...scope, callerSessionId: context.sessionID },
        { lockId: arguments_.lock_id, ttlSeconds: arguments_.ttl_seconds },
      );
      return serializeDomainResult<AdvisoryLockMutationValue, Record<string, unknown>>(
        result,
        publicAdvisoryLockMutation,
        sessionLockOwnedMutationFailureCodes,
      );
    },
  };
}
