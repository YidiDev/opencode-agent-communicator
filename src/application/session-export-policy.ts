import type { SessionExportPolicy } from "../domain/session-export";
import type { SessionExportPolicyPort } from "./session-export-ports";

export function sessionExportPolicyPort(policy: SessionExportPolicy): SessionExportPolicyPort {
  const strongest = (
    first: "allow" | "ask" | "deny",
    second: "allow" | "ask" | "deny",
  ): "allow" | "ask" | "deny" => {
    if (first === "deny" || second === "deny") return "deny";
    return first === "ask" || second === "ask" ? "ask" : "allow";
  };
  return Object.freeze({
    decisionFor(input: Parameters<SessionExportPolicyPort["decisionFor"]>[0]) {
      let mode = input.isSelf && input.isSanitized ? policy.selfSanitized : "allow";
      if (!input.isSelf) mode = strongest(mode, policy.crossSession);
      if (!input.isSanitized) mode = strongest(mode, policy.unsanitized);
      return {
        mode,
        ...(input.shouldOverwrite ? { overwrite: policy.overwrite } : {}),
      };
    },
  });
}
