import type { V2Event } from "@opencode/client";
import { SoakAssertion } from "./evidence";

/** A live, invocation-correlated result, not a reconstruction from compacted context. */
export async function waitForSoakReceipt(
  events: AsyncIterator<V2Event>,
  sessionID: string,
  callID: string,
) {
  try {
    while (true) {
      const next = await events.next();
      if (next.done) throw new SoakAssertion("tool_receipt:stream_ended");
      const event = next.value;
      if (event.type !== "session.tool.success" && event.type !== "session.tool.failed") continue;
      if (event.data.sessionID !== sessionID || event.data.id !== callID) continue;
      if (event.type === "session.tool.failed")
        throw new SoakAssertion("tool_receipt:execution_failed");
      return event.data.content;
    }
  } finally {
    // Do not stall other subscribers on the client's backpressured shared source.
    await events.return?.();
  }
}
