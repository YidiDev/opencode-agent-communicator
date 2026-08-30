import type { ProjectionSafeMessage, RenderedProjectionLine } from "../domain/session-read";
import { sessionReadLimits } from "../domain/session-read";
import { type ProjectionResult, projectSessionMessage } from "../domain/session-read-projection";

export interface SessionReadRawWork {
  readonly messages: number;
  readonly projectedTextBytes: number;
  readonly rawResponseBytes: number;
  readonly parts: number;
}

/** One invocation-wide mutable budget and projection cache. It is never exposed by a public port. */
export class SessionReadWorkBudget {
  private nativeCalls = 0;
  private messages = 0;
  private projectedTextBytes = 0;
  private rawResponseBytes = 0;
  private parts = 0;
  private renderedLines = 0;
  private readonly projections = new Map<string, readonly RenderedProjectionLine[]>();

  readonly linesByMessage: ReadonlyMap<string, readonly RenderedProjectionLine[]> =
    this.projections;

  chargeNativeCall(): boolean {
    if (this.nativeCalls >= sessionReadLimits.maxNativeCalls) return false;
    this.nativeCalls += 1;
    return true;
  }

  canExamineAnotherMessage(): boolean {
    return this.messages < sessionReadLimits.maxMessagesExamined;
  }

  remainingRawResponseBytes(): number {
    return sessionReadLimits.maxNativeResponseBytesExamined - this.rawResponseBytes;
  }

  chargeRaw(work: SessionReadRawWork): boolean {
    if (
      this.messages + work.messages > sessionReadLimits.maxMessagesExamined ||
      this.projectedTextBytes + work.projectedTextBytes >
        sessionReadLimits.maxProjectedTextBytesExamined ||
      this.rawResponseBytes + work.rawResponseBytes >
        sessionReadLimits.maxNativeResponseBytesExamined ||
      this.parts + work.parts > sessionReadLimits.maxPartsExamined
    ) {
      return false;
    }
    this.messages += work.messages;
    this.projectedTextBytes += work.projectedTextBytes;
    this.rawResponseBytes += work.rawResponseBytes;
    this.parts += work.parts;
    return true;
  }

  project(message: ProjectionSafeMessage, replace = false): ProjectionResult {
    const cached = this.projections.get(message.messageId);
    if (cached && !replace) return { ok: true, lines: cached };
    const projected = projectSessionMessage(message);
    if (!projected.ok) return projected;
    if (this.renderedLines + projected.lines.length > sessionReadLimits.maxRenderedLinesExamined) {
      return { ok: false, message: "Transcript projection exceeds the rendered line ceiling." };
    }
    this.renderedLines += projected.lines.length;
    this.projections.set(message.messageId, projected.lines);
    return projected;
  }
}
