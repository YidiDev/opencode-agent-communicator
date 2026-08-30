import { sanitizeDisplayTitle } from "./sanitize-display";
import {
  type PackedProjectionLines,
  type ProjectionSafeMessage,
  type RenderedLinePosition,
  type RenderedProjectionLine,
  sessionReadLimits,
} from "./session-read";

const encoder = new TextEncoder();

export type ProjectionResult =
  | { readonly ok: true; readonly lines: readonly RenderedProjectionLine[] }
  | { readonly ok: false; readonly message: string };

function position(
  messageId: string,
  itemKey: string,
  utf8ByteOffset: number,
): RenderedLinePosition {
  return { messageId, itemKey, utf8ByteOffset };
}

function structuralLine(messageId: string, itemKey: string, text: string): RenderedProjectionLine {
  return {
    text,
    start: position(messageId, itemKey, 0),
    end: position(messageId, itemKey, encoder.encode(text).length),
  };
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function pushWrappedPhysicalLine(
  lines: RenderedProjectionLine[],
  messageId: string,
  itemKey: string,
  physicalLine: string,
  initialOffset: number,
  includesLineFeed: boolean,
  maximumLines: number,
): number | undefined {
  let chunk = "";
  let chunkBytes = 0;
  let chunkStart = initialOffset;
  let offset = initialOffset;
  const pushChunk = (endOffset: number): boolean => {
    if (lines.length >= maximumLines) return false;
    lines.push({
      text: chunk,
      start: position(messageId, itemKey, chunkStart),
      end: position(messageId, itemKey, endOffset),
    });
    chunk = "";
    chunkBytes = 0;
    chunkStart = endOffset;
    return true;
  };

  for (const scalar of physicalLine) {
    const scalarBytes = encoder.encode(scalar).length;
    if (chunkBytes + scalarBytes > sessionReadLimits.maxRenderedLineBytes) {
      if (!pushChunk(offset)) return undefined;
    }
    chunk += scalar;
    chunkBytes += scalarBytes;
    offset += scalarBytes;
  }
  const endOffset = offset + (includesLineFeed ? 1 : 0);
  return pushChunk(endOffset) ? endOffset : undefined;
}

function projectText(
  messageId: string,
  itemKey: string,
  value: string,
  maximumLines: number,
): ProjectionResult {
  if (hasUnpairedSurrogate(value)) {
    return { ok: false, message: "Assistant text contains an unpaired Unicode surrogate." };
  }
  const lines: RenderedProjectionLine[] = [];
  let offset = 0;
  let physicalLine = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\n" && character !== "\r") {
      physicalLine += character;
      continue;
    }
    const projectedOffset = pushWrappedPhysicalLine(
      lines,
      messageId,
      itemKey,
      physicalLine,
      offset,
      true,
      maximumLines,
    );
    if (projectedOffset === undefined || lines.length >= maximumLines) {
      return { ok: false, message: "Message projection exceeds the rendered line ceiling." };
    }
    offset = projectedOffset;
    physicalLine = "";
    if (character === "\r" && value[index + 1] === "\n") index += 1;
  }
  const projectedOffset = pushWrappedPhysicalLine(
    lines,
    messageId,
    itemKey,
    physicalLine,
    offset,
    false,
    maximumLines,
  );
  if (projectedOffset === undefined || lines.length > maximumLines)
    return { ok: false, message: "Message projection exceeds the rendered line ceiling." };
  return { ok: true, lines };
}

function boundedToolName(value: string): string | undefined {
  if (hasUnpairedSurrogate(value)) return undefined;
  const sanitized = sanitizeDisplayTitle(value);
  let result = "";
  let bytes = 0;
  for (const scalar of sanitized) {
    const scalarBytes = encoder.encode(scalar).length;
    if (bytes + scalarBytes > 256) break;
    result += scalar;
    bytes += scalarBytes;
  }
  return result.length === 0 ? "unknown" : result;
}

export function projectSessionMessage(message: ProjectionSafeMessage): ProjectionResult {
  if (message.type === "user") {
    return {
      ok: true,
      lines: [structuralLine(message.messageId, "$user", "[user message omitted]")],
    };
  }

  const lines: RenderedProjectionLine[] = [
    structuralLine(message.messageId, "$assistant", "[assistant]"),
    structuralLine(message.messageId, "$assistant-state", `[assistant: ${message.state}]`),
  ];
  for (const part of message.parts) {
    if (part.type === "text") {
      const remaining = sessionReadLimits.maxRenderedLinesPerMessage - lines.length;
      if (remaining <= 0)
        return { ok: false, message: "Message projection exceeds the rendered line ceiling." };
      const projected = projectText(message.messageId, part.itemKey, part.text, remaining);
      if (!projected.ok) return projected;
      lines.push(...projected.lines);
    } else {
      const toolName = boundedToolName(part.name);
      if (toolName === undefined) {
        return { ok: false, message: "Tool name contains an unpaired Unicode surrogate." };
      }
      lines.push(
        structuralLine(message.messageId, part.itemKey, `[tool: ${toolName} ${part.status}]`),
      );
      if (lines.length > sessionReadLimits.maxRenderedLinesPerMessage) {
        return { ok: false, message: "Message projection exceeds the rendered line ceiling." };
      }
    }
  }
  return { ok: true, lines };
}

export function projectSessionMessages(
  messages: readonly ProjectionSafeMessage[],
): ProjectionResult {
  const lines: RenderedProjectionLine[] = [];
  for (const message of messages) {
    const projected = projectSessionMessage(message);
    if (!projected.ok) return projected;
    lines.push(...projected.lines);
  }
  return { ok: true, lines };
}

function selectedBytes(lines: readonly RenderedProjectionLine[]): number {
  let bytes = Math.max(0, lines.length - 1);
  for (const line of lines) bytes += encoder.encode(line.text).length;
  return bytes;
}

/** Packs whole rendered lines and preserves chronological order. */
export function packProjectionLines(
  lines: readonly RenderedProjectionLine[],
  requestedLines: number = sessionReadLimits.defaultLines,
  fromEnd = false,
): PackedProjectionLines {
  const limit = Math.min(Math.max(0, requestedLines), sessionReadLimits.maxLines);
  const selected: RenderedProjectionLine[] = [];
  const ordered = fromEnd ? [...lines].reverse() : lines;
  for (const line of ordered) {
    const candidate = fromEnd ? [line, ...selected] : [...selected, line];
    if (candidate.length > limit || selectedBytes(candidate) > sessionReadLimits.maxContentBytes)
      break;
    if (fromEnd) selected.unshift(line);
    else selected.push(line);
  }
  return {
    content: selected.map((line) => line.text).join("\n"),
    lines: selected,
    hasMore: selected.length < lines.length,
  };
}
