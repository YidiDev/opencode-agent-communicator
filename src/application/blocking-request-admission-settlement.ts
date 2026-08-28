import type { PendingRequestMetadata } from "../domain/request-types";
import { runUntilAborted } from "./abortable-operation";
import type {
  SessionBlockingRequestContext,
  SessionBlockingRequestPorts,
} from "./blocking-session-request-boundaries";
import { observeNativePromiseRejection } from "./native-promise-observation";

const admissionCleanupTimeoutMs = 1_000;

export async function settleAdmissionForeground<Value>(
  ports: SessionBlockingRequestPorts,
  context: SessionBlockingRequestContext,
  operation: () => Promise<Value>,
) {
  const controller = new AbortController();
  let timer: { cancel(): void } | undefined;
  const abort = (): void => controller.abort("request_admission_settlement_cancelled");
  try {
    context.abort.addEventListener("abort", abort, { once: true });
    if (context.abort.aborted) abort();
    const nowMs = ports.clock.nowMs();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) return { kind: "aborted" as const };
    timer = ports.deadlineTimer.arm(Math.max(0, context.deadlineMs - nowMs), () =>
      controller.abort("request_admission_settlement_deadline"),
    );
    return await runUntilAborted(controller.signal, operation);
  } catch (cause: unknown) {
    return { kind: "rejected" as const, cause };
  } finally {
    context.abort.removeEventListener("abort", abort);
    timer?.cancel();
  }
}

export async function settleAdmissionCleanup<Value>(
  ports: SessionBlockingRequestPorts,
  operation: () => Promise<Value>,
) {
  const controller = new AbortController();
  let timer: { cancel(): void } | undefined;
  const stop = (): void => controller.abort("request_admission_lifecycle_stopped");
  try {
    ports.runtime.effectSignal.addEventListener("abort", stop, { once: true });
    if (ports.runtime.effectSignal.aborted) stop();
    timer = ports.deadlineTimer.arm(admissionCleanupTimeoutMs, () =>
      controller.abort("request_admission_cleanup_deadline"),
    );
    return await runUntilAborted(controller.signal, operation);
  } catch (cause: unknown) {
    return { kind: "rejected" as const, cause };
  } finally {
    ports.runtime.effectSignal.removeEventListener("abort", stop);
    timer?.cancel();
  }
}

export function wakeAfterRequestAdmission(
  ports: SessionBlockingRequestPorts,
  request: PendingRequestMetadata,
): void {
  try {
    const returned: unknown = ports.scheduler.wake();
    if (returned !== undefined) observeNativePromiseRejection(returned);
  } catch {}
  ports.runtime.wakeRequest(request.id);
}
