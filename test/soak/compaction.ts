import { SoakAssertion } from "./evidence";

export function requireSoakCompactionCoverage(smoke: boolean, counts: readonly number[]): void {
  if (
    counts.length !== 2 ||
    counts.some(
      (count) =>
        !Number.isSafeInteger(count) || count < 0 || count > 1024 || (!smoke && count === 0),
    )
  )
    throw new SoakAssertion("native_compaction:coverage_missing");
}

export function recordSoakCompactions(
  seen: Set<string>,
  messages: readonly { type: string; id: string; status?: string }[],
): void {
  for (const message of messages) {
    if (message.type !== "compaction") continue;
    if (message.status === "failed") throw new SoakAssertion("native_compaction:failed");
    if (message.status === "completed") seen.add(message.id);
    if (seen.size > 1024) throw new SoakAssertion("native_compaction:observation_bound");
  }
}

/** Read only the latest user input, including an unfinished exchange retained by compaction. */
export function latestSoakUserText(body: unknown): string | undefined {
  if (
    typeof body !== "object" ||
    body === null ||
    !("messages" in body) ||
    !Array.isArray(body.messages)
  )
    return undefined;
  const last = body.messages.at(-1);
  if (last?.role !== "user") return undefined;
  const text =
    typeof last.content === "string"
      ? last.content
      : Array.isArray(last.content)
        ? last.content
            .map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : ""))
            .join("")
        : "";
  if (!text.trimStart().startsWith("<conversation-checkpoint>")) return text;
  const recent = text.match(/<recent-context>([\s\S]*?)<\/recent-context>/)?.[1];
  if (!recent) return undefined;
  const index = [...recent.matchAll(/^\[User\]: /gm)].at(-1)?.index;
  if (index === undefined) return undefined;
  const pending = recent.slice(index + "[User]: ".length).trim();
  // Never replay a command that already has an assistant/tool response, or read the summary as input.
  if (/^\[(?:Assistant|Tool|Synthetic|Shell|Skill)[^\]]*\]:/m.test(pending)) return undefined;
  return pending;
}

export function soakCompactionSummary(body: unknown): string | undefined {
  const text = latestSoakUserText(body);
  if (
    !text ||
    ![
      "You MUST summarize the conversation above into a structured summary",
      "Update the existing checkpoint in the conversation above into one consolidated summary.",
      "The previous response did not fill in the required summary template.",
    ].some((prefix) => text.startsWith(prefix))
  )
    return undefined;
  return [
    "## Objective",
    "- Exercise synthetic communicator tool journeys in an isolated runtime.",
    "## Requirements",
    "- Use only explicitly advertised communicator tools for the latest fixture input.",
    "## Decisions",
    "- Earlier completed commands must not be replayed.",
    "## Work State",
    "### Completed",
    "- Prior fixture turns.",
    "### Active",
    "- The unanswered latest user input retained in recent context.",
    "### Blocked",
    "- (none)",
    "## Next Move",
    "1. Handle only that unanswered latest input, then remain idle.",
    "## Relevant Files",
    "- (none)",
    "## Important Context",
    "- All input is synthetic; no personal workspace is involved.",
  ].join("\n");
}
