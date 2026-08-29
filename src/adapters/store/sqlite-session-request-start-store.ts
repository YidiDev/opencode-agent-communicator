import type {
  PrepareSessionRequestStartInput,
  SessionRequestStartPersistencePort,
  SessionRequestStartStoreResult,
} from "../../application/session-start-ports";
import { validateRequestId } from "../../domain/generated-ids";
import {
  selectStartOperation,
  settleTerminalLinkedStart,
} from "./session-request-start-correlation";
import { SqliteStoreCore } from "./sqlite-store-core";
import {
  hydrateStartOperation,
  type StartOperationRow,
  startOperationColumns,
} from "./start-operation-rows";

type CompositeFailureCode = Extract<SessionRequestStartStoreResult, { readonly ok: false }>["code"];

class CompositePreparationRejected extends Error {
  constructor(readonly code: CompositeFailureCode) {
    super("Composite start/request preparation was rejected.");
  }
}

function requestIdForStart(operationId: string) {
  const requestId = validateRequestId(`req_${operationId.slice(3)}`);
  if (!requestId.ok) throw new Error("Stored start operation could not bind its linked request.");
  return requestId.value;
}

/** Owns the transactional coupling between managed starts and their initial durable requests. */
export class SqliteSessionRequestStartStore
  extends SqliteStoreCore
  implements SessionRequestStartPersistencePort
{
  async readSessionRequestStartByOperation(
    input: Parameters<
      NonNullable<SessionRequestStartPersistencePort["readSessionRequestStartByOperation"]>
    >[0],
  ): ReturnType<
    NonNullable<SessionRequestStartPersistencePort["readSessionRequestStartByOperation"]>
  > {
    this.assertOpen();
    return this.access.mutate(() => {
      return this.context.database
        .transaction(() => {
          this.ownershipRepository.assertCurrent(input.fencingToken);
          if (input.workspaceKey !== this.context.workspaceKey) return undefined;
          let operation = selectStartOperation(this.context, input.workspaceKey, input.operationId);
          if (!operation) return undefined;
          const request = this.requestRepository.getRequestMetadataForRecovery({
            fencingToken: input.fencingToken,
            workspaceKey: input.workspaceKey,
            requestId: requestIdForStart(operation.id),
          });
          if (request?.linkedStartOperationId !== operation.id) return undefined;
          if (request.resolutionState !== "pending") {
            settleTerminalLinkedStart(this.context, operation, request);
            const settled = selectStartOperation(this.context, input.workspaceKey, operation.id);
            if (!settled) throw new Error("Settled linked start operation is absent.");
            operation = settled;
          }
          return { operation, request };
        })
        .immediate();
    });
  }

  async readSessionRequestStart(
    input: Parameters<SessionRequestStartPersistencePort["readSessionRequestStart"]>[0],
  ): ReturnType<SessionRequestStartPersistencePort["readSessionRequestStart"]> {
    this.assertOpen();
    return this.access.mutate(() => {
      return this.context.database
        .transaction(() => {
          this.ownershipRepository.assertOrdinaryWorkAllowed(input.fencingToken);
          if (input.workspaceKey !== this.context.workspaceKey) {
            return { ok: false as const, code: "state_conflict" as const };
          }
          const row = this.context.database
            .query<
              StartOperationRow & { readonly idempotencyDigest: string },
              [string, string, string]
            >(
              `SELECT ${startOperationColumns},
                 COALESCE(idempotency_arguments_sha256, arguments_sha256) AS idempotencyDigest
               FROM start_operations
               WHERE workspace_key = ? AND source_session_id = ? AND idempotency_key = ?`,
            )
            .get(input.workspaceKey, input.sourceSessionId, input.idempotencyKey);
          if (!row) return { ok: true as const, found: false as const };
          if (row.idempotencyDigest !== input.idempotencyArgumentsSha256) {
            return { ok: false as const, code: "idempotency_conflict" as const };
          }
          let operation = hydrateStartOperation(row);
          const request = this.requestRepository.getRequestMetadata({
            fencingToken: input.fencingToken,
            workspaceKey: input.workspaceKey,
            requestId: requestIdForStart(operation.id),
          });
          if (request?.linkedStartOperationId !== operation.id) {
            return { ok: false as const, code: "state_conflict" as const };
          }
          if (request.resolutionState !== "pending") {
            settleTerminalLinkedStart(this.context, operation, request);
            const settled = selectStartOperation(this.context, input.workspaceKey, operation.id);
            if (!settled) throw new Error("Settled linked start operation is absent.");
            operation = settled;
          }
          return { ok: true as const, found: true as const, operation, request };
        })
        .immediate();
    });
  }

  async createOrResumeSessionRequestStart(
    input: PrepareSessionRequestStartInput,
  ): Promise<SessionRequestStartStoreResult> {
    this.assertOpen();
    return this.access.mutate(() => {
      if (
        input.request.creationOperationId !== input.start.operationId ||
        input.request.deliveryMode !== "initial" ||
        input.request.linkedStartOperationId !== input.start.operationId ||
        input.request.request.workspaceKey !== input.start.workspaceKey ||
        input.request.request.sourceSessionId !== input.start.sourceSessionId ||
        input.request.request.targetSessionId !== input.start.sessionId ||
        input.request.request.nativeMessageId !== input.start.nativeMessageId
      ) {
        return { ok: false as const, code: "state_conflict" as const };
      }
      try {
        return this.context.database
          .transaction(() => {
            const start = this.startRepository.createOrResumeInTransaction(input.start);
            if (!start.ok) throw new CompositePreparationRejected(start.code);

            // Exact replays return the existing link instead of inserting newly generated IDs.
            if (start.operation.id !== input.start.operationId) {
              const request = this.requestRepository.getRequestMetadata({
                fencingToken: input.start.fencingToken,
                workspaceKey: input.start.workspaceKey,
                requestId: requestIdForStart(start.operation.id),
              });
              if (!request || request.linkedStartOperationId !== start.operation.id) {
                throw new CompositePreparationRejected("state_conflict");
              }
              return {
                ok: true as const,
                operation: start.operation,
                request,
                idempotencyArgumentsSha256:
                  input.start.idempotencyArgumentsSha256 ?? input.start.argumentsSha256,
              };
            }

            const request = this.requestRepository.createPreparedInTransaction(input.request);
            if (!request.ok) throw new CompositePreparationRejected(request.code);
            return {
              ok: true as const,
              operation: start.operation,
              request: request.request,
              idempotencyArgumentsSha256:
                input.start.idempotencyArgumentsSha256 ?? input.start.argumentsSha256,
            };
          })
          .immediate();
      } catch (cause: unknown) {
        if (cause instanceof CompositePreparationRejected) {
          return { ok: false as const, code: cause.code };
        }
        throw cause;
      }
    });
  }
}
