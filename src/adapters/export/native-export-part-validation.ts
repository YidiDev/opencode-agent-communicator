import {
  isExportBoolean as boolean,
  type ExportData as Data,
  exportKeys as keys,
  isExportNumber as number,
  exportRecord as record,
  isExportString as string,
} from "./native-export-shape";
import { validNativeToolState as toolState } from "./native-export-tool-state";

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);

function tokens(value: unknown): boolean {
  const item = record(value);
  const cache = record(item?.cache);
  return (
    !!item &&
    keys(item, ["input", "output", "reasoning", "cache"], ["total"]) &&
    number(item.input) &&
    number(item.output) &&
    number(item.reasoning) &&
    (item.total === undefined || number(item.total)) &&
    !!cache &&
    keys(cache, ["read", "write"]) &&
    number(cache.read) &&
    number(cache.write)
  );
}

function commonPart(item: Data, sessionId: string, messageId: string): boolean {
  return (
    string(item.id) &&
    item.sessionID === sessionId &&
    item.messageID === messageId &&
    string(item.type)
  );
}

export function validNativePart(value: unknown, sessionId: string, messageId: string): boolean {
  const item = record(value);
  if (!item || !commonPart(item, sessionId, messageId)) return false;
  const base = ["id", "sessionID", "messageID", "type"];
  switch (item.type) {
    case "text":
      return (
        keys(item, [...base, "text"], ["synthetic", "ignored", "time", "metadata"]) &&
        string(item.text)
      );
    case "reasoning":
      return (
        keys(item, [...base, "text", "time"], ["metadata"]) &&
        string(item.text) &&
        !!record(item.time)
      );
    case "file":
      return (
        keys(item, [...base, "mime", "url"], ["filename", "source"]) &&
        string(item.mime) &&
        string(item.url)
      );
    case "tool":
      return (
        keys(item, [...base, "callID", "tool", "state"], ["metadata"]) &&
        string(item.callID) &&
        string(item.tool) &&
        toolState(item.state)
      );
    case "step-start":
      return (
        keys(item, base, ["snapshot"]) && (item.snapshot === undefined || string(item.snapshot))
      );
    case "step-finish":
      return (
        keys(item, [...base, "reason", "cost", "tokens"], ["snapshot"]) &&
        string(item.reason) &&
        number(item.cost) &&
        tokens(item.tokens)
      );
    case "snapshot":
      return keys(item, [...base, "snapshot"]) && string(item.snapshot);
    case "patch":
      return keys(item, [...base, "hash", "files"]) && string(item.hash) && strings(item.files);
    case "agent":
      return keys(item, [...base, "name"], ["source"]) && string(item.name);
    case "retry":
      return (
        keys(item, [...base, "attempt", "error", "time"]) &&
        number(item.attempt) &&
        !!record(item.error) &&
        !!record(item.time)
      );
    case "compaction":
      return keys(item, [...base, "auto"]) && boolean(item.auto);
    case "subtask":
      return (
        keys(item, [...base, "prompt", "description", "agent"]) &&
        string(item.prompt) &&
        string(item.description) &&
        string(item.agent)
      );
    default:
      return false;
  }
}

export { tokens as validNativeTokens };
