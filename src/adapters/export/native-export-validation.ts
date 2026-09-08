import { isSupportedOpenCodeVersion } from "../../domain/host";
import type { SessionId } from "../../domain/sessions";
import { BoundedJsonFault, BoundedJsonParser } from "./bounded-json-parser";
import {
  validNativePart as part,
  validNativeTokens as tokens,
} from "./native-export-part-validation";
import {
  isExportBoolean as boolean,
  exportKeys as keys,
  isExportNumber as number,
  exportRecord as record,
  isExportString as string,
} from "./native-export-shape";
import { nativeJsonHardLimits } from "./native-json-limits";

export type NativeExportValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "malformed" | "wrong_session" | "not_sanitized" | "limit" | "deadline";
    };

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

export function validateNativeExportValue(
  raw: unknown,
  sessionId: SessionId,
  isSanitized: boolean,
): NativeExportValidation {
  const root = record(raw);
  if (!root || !keys(root, ["info", "messages"]) || !Array.isArray(root.messages)) {
    return { ok: false, reason: "malformed" };
  }
  if (root.messages.length > nativeJsonHardLimits.maximumMessages) {
    return { ok: false, reason: "limit" };
  }
  const info = sessionInfo(root.info, sessionId, isSanitized);
  if (!info.ok) return info;
  let partCount = 0;
  for (const message of root.messages) {
    const item = record(message);
    if (!item || !keys(item, ["info", "parts"]) || !Array.isArray(item.parts)) {
      return { ok: false, reason: "malformed" };
    }
    partCount += item.parts.length;
    if (partCount > nativeJsonHardLimits.maximumParts) {
      return { ok: false, reason: "limit" };
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

/** Strictly validates bounded bytes against the supported OpenCode 1.18 import envelope. */
export function validateNativeExport(
  bytes: Uint8Array,
  sessionId: SessionId,
  isSanitized: boolean,
): NativeExportValidation {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parser = new BoundedJsonParser();
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += 64 * 1024) {
      parser.feed(decoder.decode(bytes.subarray(offset, offset + 64 * 1024), { stream: true }));
    }
    parser.feed(decoder.decode());
    return validateNativeExportValue(parser.finish(), sessionId, isSanitized);
  } catch (cause: unknown) {
    return {
      ok: false,
      reason: cause instanceof BoundedJsonFault && cause.kind === "limit" ? "limit" : "malformed",
    };
  }
}
