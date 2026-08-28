import { isSupportedOpenCodeVersion } from "../../domain/host";
import type { SessionId } from "../../domain/sessions";
import {
  isExportBoolean as boolean,
  type ExportData as Data,
  exportKeys as keys,
  isExportNumber as number,
  exportRecord as record,
  isExportString as string,
} from "./native-export-shape";
import { validNativeToolState as toolState } from "./native-export-tool-state";

export type NativeExportValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "malformed" | "wrong_session" | "not_sanitized" };

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);

function stringMap(value: unknown, predicate: (item: unknown) => boolean): boolean {
  const item = record(value);
  return !!item && Object.values(item).every(predicate);
}

function time(value: unknown, completion = false): boolean {
  const item = record(value);
  return (
    !!item &&
    keys(item, ["created"], completion ? ["completed"] : []) &&
    number(item.created) &&
    (item.completed === undefined || number(item.completed))
  );
}

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

function sessionInfo(value: unknown, id: string, sanitized: boolean): NativeExportValidation {
  const item = record(value);
  if (
    !item ||
    !keys(
      item,
      ["id", "slug", "projectID", "directory", "title", "version", "time"],
      [
        "workspaceID",
        "path",
        "parentID",
        "summary",
        "cost",
        "tokens",
        "share",
        "agent",
        "model",
        "metadata",
        "permission",
        "revert",
      ],
    )
  )
    return { ok: false, reason: "malformed" };
  if (item.id !== id) return { ok: false, reason: "wrong_session" };
  const itemTime = record(item.time);
  if (
    !string(item.slug) ||
    !string(item.projectID) ||
    !string(item.directory) ||
    !string(item.title) ||
    !isSupportedOpenCodeVersion(item.version) ||
    !itemTime ||
    !keys(itemTime, ["created", "updated"], ["compacting", "archived"]) ||
    !number(itemTime.created) ||
    !number(itemTime.updated) ||
    (itemTime.compacting !== undefined && !number(itemTime.compacting)) ||
    (itemTime.archived !== undefined && !number(itemTime.archived)) ||
    (item.workspaceID !== undefined && !string(item.workspaceID)) ||
    (item.path !== undefined && !string(item.path)) ||
    (item.parentID !== undefined && !string(item.parentID)) ||
    (item.cost !== undefined && !number(item.cost)) ||
    (item.tokens !== undefined && !tokens(item.tokens)) ||
    (item.agent !== undefined && !string(item.agent)) ||
    (item.metadata !== undefined && !record(item.metadata)) ||
    (item.permission !== undefined && !Array.isArray(item.permission))
  )
    return { ok: false, reason: "malformed" };
  if (
    sanitized &&
    (item.title !== `[redacted:session-title:${id}]` ||
      item.directory !== `[redacted:session-directory:${id}]`)
  ) {
    return { ok: false, reason: "not_sanitized" };
  }
  return { ok: true };
}

function messageInfo(value: unknown, sessionId: string): { ok: boolean; id?: string } {
  const item = record(value);
  if (!item || !string(item.id) || item.sessionID !== sessionId || !string(item.role))
    return { ok: false };
  if (item.role === "user") {
    const model = record(item.model);
    if (
      !keys(
        item,
        ["id", "sessionID", "role", "time", "agent", "model"],
        ["format", "summary", "system", "tools"],
      ) ||
      !time(item.time) ||
      !string(item.agent) ||
      !model ||
      !keys(model, ["providerID", "modelID"], ["variant"]) ||
      !string(model.providerID) ||
      !string(model.modelID) ||
      (model.variant !== undefined && !string(model.variant)) ||
      (item.system !== undefined && !string(item.system)) ||
      (item.tools !== undefined && !stringMap(item.tools, boolean))
    )
      return { ok: false };
  } else if (item.role === "assistant") {
    const path = record(item.path);
    if (
      !keys(
        item,
        [
          "id",
          "sessionID",
          "role",
          "time",
          "parentID",
          "modelID",
          "providerID",
          "mode",
          "agent",
          "path",
          "cost",
          "tokens",
        ],
        ["error", "summary", "structured", "variant", "finish"],
      ) ||
      !time(item.time, true) ||
      !string(item.parentID) ||
      !string(item.modelID) ||
      !string(item.providerID) ||
      !string(item.mode) ||
      !string(item.agent) ||
      !path ||
      !keys(path, ["cwd", "root"]) ||
      !string(path.cwd) ||
      !string(path.root) ||
      !number(item.cost) ||
      !tokens(item.tokens) ||
      (item.summary !== undefined && !boolean(item.summary)) ||
      (item.variant !== undefined && !string(item.variant)) ||
      (item.finish !== undefined && !string(item.finish)) ||
      (item.error !== undefined && !record(item.error))
    )
      return { ok: false };
  } else return { ok: false };
  return { ok: true, id: item.id };
}

function commonPart(item: Data, sessionId: string, messageId: string): boolean {
  return (
    string(item.id) &&
    item.sessionID === sessionId &&
    item.messageID === messageId &&
    string(item.type)
  );
}

function part(value: unknown, sessionId: string, messageId: string): boolean {
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

/** Strictly validates the supported OpenCode 1.18 import envelope and declared variants. */
export function validateNativeExport(
  bytes: Uint8Array,
  sessionId: SessionId,
  isSanitized: boolean,
): NativeExportValidation {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const root = record(raw);
  if (!root || !keys(root, ["info", "messages"]) || !Array.isArray(root.messages)) {
    return { ok: false, reason: "malformed" };
  }
  const info = sessionInfo(root.info, sessionId, isSanitized);
  if (!info.ok) return info;
  for (const message of root.messages) {
    const item = record(message);
    if (!item || !keys(item, ["info", "parts"]) || !Array.isArray(item.parts)) {
      return { ok: false, reason: "malformed" };
    }
    const messageResult = messageInfo(item.info, sessionId);
    if (
      !messageResult.ok ||
      !messageResult.id ||
      !item.parts.every((value) => part(value, sessionId, messageResult.id as string))
    ) {
      return { ok: false, reason: "malformed" };
    }
  }
  return { ok: true };
}
