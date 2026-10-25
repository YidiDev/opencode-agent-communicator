import { domainFailureCodes } from "../../src/domain/results";
import { SoakAssertion } from "./evidence";
import { invokeSoakTool, type SoakHost } from "./host";

function safeCode(result: Awaited<ReturnType<typeof invokeSoakTool>>) {
  return domainFailureCodes.find((code) => code === result.error?.code) ?? "unclassified";
}

function requireSuccess(result: Awaited<ReturnType<typeof invokeSoakTool>>) {
  if (!result.ok) throw new SoakAssertion(`${result.operation}:${safeCode(result)}`);
  return result.value;
}

function identity(result: Awaited<ReturnType<typeof invokeSoakTool>>, key: string): string {
  const value = requireSuccess(result)?.[key];
  if (typeof value !== "string") throw new Error("Soak result identity missing");
  return value;
}

export async function createSoakRoots(host: SoakHost): Promise<readonly [string, string]> {
  const create = () =>
    host.client.session.create(
      {
        title: "Isolated runtime soak fixture",
        agent: "build",
        model: { providerID: "live-test", id: "deterministic-model" },
        location: { directory: host.isolation.project },
      },
      { signal: AbortSignal.timeout(30_000) },
    );
  const roots = await Promise.all([create(), create()]);
  return [roots[0].id, roots[1].id];
}

export async function exerciseSoakHost(
  host: SoakHost,
  roots: readonly [string, string],
  full: boolean,
) {
  const published = await Promise.all(
    roots.map((session) =>
      invokeSoakTool(host, session, "session_lock_publish", {
        ttl_seconds: 300,
        title: "Soak fixture",
        description: "Synthetic isolated ownership exercise",
        instructions: "No user workspace is involved",
      }),
    ),
  );
  const locks = published.map((result) => {
    const lock = requireSuccess(result)?.lock as { lock_id?: string } | undefined;
    if (typeof lock?.lock_id !== "string") throw new Error("Soak lock identity missing");
    return lock.lock_id;
  });
  requireSuccess(await invokeSoakTool(host, roots[0], "session_lock_list"));
  requireSuccess(
    await invokeSoakTool(host, roots[0], "session_lock_renew", {
      lock_id: locks[0],
      ttl_seconds: 300,
    }),
  );
  await Promise.all(
    roots.map(async (session, index) => {
      requireSuccess(
        await invokeSoakTool(host, session, "session_lock_release", { lock_id: locks[index] }),
      );
      requireSuccess(await invokeSoakTool(host, session, "session_list"));
      requireSuccess(
        await invokeSoakTool(host, session, "session_read", { session_id: session, limit: 2 }),
      );
    }),
  );
  if (!full) return;
  await exerciseSoakRequests(host, roots);
  requireSuccess(
    await invokeSoakTool(host, roots[0], "session_ask", {
      session_id: roots[1],
      questions: [{ prompt: "Synthetic blocking soak choice", options: ["yes", "no"] }],
      timeout_seconds: 15,
    }),
  );
  requireSuccess(
    await invokeSoakTool(host, roots[0], "session_wait", {
      session_id: roots[1],
      milestone: "synthetic-blocking-ready",
      timeout_seconds: 15,
    }),
  );
  for (const [name, arguments_, code] of [
    ["session_read", { session_id: roots[1] }, "permission_denied"],
    [
      "session_send",
      { session_id: roots[1], content: "Synthetic context refusal", delivery: "context" },
      "target_status_unknown",
    ],
    ["session_stop", { session_id: roots[1] }, "native_unavailable"],
    [
      "session_start",
      { idempotency_key: "soak-denied-start", initial_message: "Synthetic denied start" },
      "permission_denied",
    ],
    [
      "session_request_start",
      {
        idempotency_key: "soak-denied-request-start",
        initial_message: "Synthetic denied start",
        request: { kind: "wait", milestone: "denied", timeout_seconds: 30 },
      },
      "permission_denied",
    ],
    ["session_export", { destination: "synthetic-soak.json" }, "export_unavailable"],
  ] as const) {
    const result = await invokeSoakTool(host, roots[0], name, arguments_);
    if (result.ok || result.error?.code !== code)
      throw new SoakAssertion(
        `${name}:expected_${code}:got_${result.ok ? "success" : safeCode(result)}`,
      );
  }
}

export async function exerciseSoakRequests(host: SoakHost, roots: readonly [string, string]) {
  const [source, target] = roots;
  const delivery = await invokeSoakTool(host, source, "session_send", {
    session_id: target,
    content: "Synthetic soak delivery",
    delivery: "user",
  });
  const deliveryID = identity(delivery, "delivery_id");
  requireSuccess(
    await invokeSoakTool(host, source, "session_delivery_get", { delivery_id: deliveryID }),
  );
  await host.client.session.wait({ sessionID: target }, { signal: AbortSignal.timeout(30_000) });
  for (const kind of ["ask", "wait"] as const) {
    const request =
      kind === "ask"
        ? {
            kind,
            questions: [{ prompt: "Synthetic fixture choice", options: ["yes", "no"] }],
            timeout_seconds: 180,
          }
        : { kind, milestone: "synthetic-ready", timeout_seconds: 180 };
    const id = identity(
      await invokeSoakTool(host, source, "session_request_send", {
        session_id: target,
        content: "Synthetic soak request",
        request,
      }),
      "request_id",
    );
    await host.client.session.wait({ sessionID: target }, { signal: AbortSignal.timeout(30_000) });
    requireSuccess(await invokeSoakTool(host, target, "session_request_get", { request_id: id }));
    requireSuccess(
      await invokeSoakTool(
        host,
        target,
        kind === "ask" ? "session_respond" : "session_signal",
        kind === "ask"
          ? { request_id: id, answers: [["yes"]] }
          : { request_id: id, evidence: "artifact://synthetic-soak" },
      ),
    );
    const result = requireSuccess(
      await invokeSoakTool(host, source, "session_request_get", { request_id: id }),
    );
    const metadata = result?.metadata as { resolution_state?: string } | undefined;
    if (metadata?.resolution_state !== (kind === "ask" ? "answered" : "reached"))
      throw new Error("Soak durable result was not retained");
    requireSuccess(await invokeSoakTool(host, source, "session_request_ack", { request_id: id }));
  }
  const cancelled = identity(
    await invokeSoakTool(host, source, "session_request_send", {
      session_id: target,
      content: "Synthetic cancellation fixture",
      request: { kind: "wait", milestone: "synthetic-cancel", timeout_seconds: 180 },
    }),
    "request_id",
  );
  requireSuccess(
    await invokeSoakTool(host, source, "session_request_cancel", { request_id: cancelled }),
  );
  requireSuccess(await invokeSoakTool(host, source, "session_request_list"));
  await host.client.session.wait({ sessionID: target }, { signal: AbortSignal.timeout(30_000) });
}
