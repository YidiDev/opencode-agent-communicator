import { type Plugin, tool } from "@opencode-ai/plugin";
import { deriveTranscriptSessionIdentity } from "../../../src/domain/transcript-session-identity";

export const ContextCoexistencePlugin: Plugin = async () => ({
  "experimental.chat.messages.transform": async (_input, output) => {
    const identity = deriveTranscriptSessionIdentity(output.messages);
    for (let index = output.messages.length - 1; index >= 0; index -= 1) {
      const message = output.messages[index];
      if (message?.info.role !== "user") continue;
      const part = [...message.parts].reverse().find((candidate) => candidate.type === "text");
      if (part?.type !== "text") return;
      part.text += `\n\nlive coexistence reminder identity:${identity.ok ? identity.sessionId : identity.reason}`;
      return;
    }
  },
  tool: {
    live_context_noop: tool({
      description: "Complete immediately to exercise a live multi-step provider loop.",
      args: {},
      execute: async () => "live context noop complete",
    }),
    live_context_hold: tool({
      description: "Hold a live target active briefly for context admission acceptance.",
      args: {},
      execute: async () => {
        await Bun.sleep(10_000);
        return "live context hold complete";
      },
    }),
  },
});
