import type { LinuxBunSqliteStore } from "../adapters/store/sqlite-store";
import type { ParticipantDeletionLifecycle } from "../application/participant-deletion-lifecycle";
import type { CommunicatorStartupRecoveryLifecycle } from "../application/recover-communicator-startup";
import type { RequestRuntime } from "../application/request-runtime";
import type { ActiveInvocationRegistry } from "./active-invocations";

export function createCompositionDisposer(input: {
  readonly lifecycle: () => CommunicatorStartupRecoveryLifecycle | undefined;
  readonly deletion: () => ParticipantDeletionLifecycle | undefined;
  readonly runtime: () => RequestRuntime | undefined;
  readonly invocations: ActiveInvocationRegistry;
  readonly exporterDrain: () => (() => Promise<void>) | undefined;
  readonly exporterDispose: () => (() => void) | undefined;
  readonly advisoryLockDispose: () => (() => void) | undefined;
  readonly advisoryLockDrain: () => (() => Promise<void>) | undefined;
  readonly store: () => LinuxBunSqliteStore | undefined;
}): () => Promise<void> {
  let disposal: Promise<void> | undefined;
  return () => {
    disposal ??= (async () => {
      let firstError: unknown;
      const capture = async (operation: () => void | Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (cause: unknown) {
          firstError ??= cause;
        }
      };
      const lifecycle = input.lifecycle();
      await capture(() => input.deletion()?.dispose());
      await capture(() => lifecycle?.stop("shutdown") ?? input.runtime()?.stop("shutdown"));
      await capture(() => input.advisoryLockDispose()?.());
      await capture(() => input.invocations.shutdown());
      const advisoryLockDrain = input.advisoryLockDrain();
      if (advisoryLockDrain) await capture(advisoryLockDrain);
      if (lifecycle) await capture(() => lifecycle.scheduler.drain());
      const exporterDrain = input.exporterDrain();
      if (exporterDrain) await capture(exporterDrain);
      const exporterDispose = input.exporterDispose();
      if (exporterDispose) await capture(exporterDispose);
      await capture(() => input.store()?.close());
      if (firstError !== undefined) throw firstError;
    })();
    return disposal;
  };
}
