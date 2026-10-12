import type { MessageAuthorizationPort, OperationControl } from "../application/delivery-ports";
import type { RequestAuthorizationPort } from "../application/request-authorization-port";
import type { PolicyDecision } from "../domain/authorization-policy";

async function decide(
  policy: PolicyDecision | unknown,
  control: OperationControl,
): Promise<{ readonly kind: "allow" | "deny" | "approval_rejected" }> {
  if (control.abort.aborted) return { kind: "deny" };
  return { kind: policy === "allow" ? "allow" : "deny" };
}

export function invocationMessageAuthorization(
  policy: PolicyDecision | unknown,
  _legacyContext?: unknown,
): MessageAuthorizationPort {
  return Object.freeze({
    async authorizeMessage(
      binding: Parameters<MessageAuthorizationPort["authorizeMessage"]>[0],
      control: Parameters<MessageAuthorizationPort["authorizeMessage"]>[1],
    ) {
      void binding;
      return decide(policy, control);
    },
  });
}

export function invocationRequestAuthorization(
  policies: Readonly<{ ask: PolicyDecision | unknown; wait: PolicyDecision | unknown }>,
  _legacyContext?: unknown,
): RequestAuthorizationPort {
  return Object.freeze({
    async authorizeRequest(
      binding: Parameters<RequestAuthorizationPort["authorizeRequest"]>[0],
      control: Parameters<RequestAuthorizationPort["authorizeRequest"]>[1],
    ) {
      return decide(policies[binding.operation], control);
    },
  });
}
