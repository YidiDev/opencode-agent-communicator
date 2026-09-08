import type { SessionId } from "../../domain/sessions";
import { BoundedJsonFault, BoundedJsonParser } from "./bounded-json-parser";
import type { NativeExportValidation } from "./native-export-validation";
import { validateNativeExportValue } from "./native-export-validation";

const decodeSliceBytes = 64 * 1024;

interface NativeExportStreamValidatorInput {
  readonly sessionId: SessionId;
  readonly isSanitized: boolean;
  readonly deadlineMs: number;
  readonly now?: () => number;
}

/** Decodes and parses bounded slices so stdout is never duplicated as one retained byte buffer. */
export class NativeExportStreamValidator {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly parser = new BoundedJsonParser();
  private readonly now: () => number;
  private failure: NativeExportValidation | undefined;

  constructor(private readonly input: NativeExportStreamValidatorInput) {
    this.now = input.now ?? Date.now;
  }

  feed(bytes: Uint8Array): void {
    if (this.failure) return;
    try {
      for (let offset = 0; offset < bytes.byteLength; offset += decodeSliceBytes) {
        if (this.now() >= this.input.deadlineMs) {
          this.failure = { ok: false, reason: "deadline" };
          return;
        }
        const end = Math.min(offset + decodeSliceBytes, bytes.byteLength);
        this.parser.feed(this.decoder.decode(bytes.subarray(offset, end), { stream: true }));
      }
    } catch (cause: unknown) {
      this.failure = this.classify(cause);
    }
  }

  finish(): NativeExportValidation {
    if (this.failure) return this.failure;
    if (this.now() >= this.input.deadlineMs) return { ok: false, reason: "deadline" };
    try {
      this.parser.feed(this.decoder.decode());
      return validateNativeExportValue(
        this.parser.finish(),
        this.input.sessionId,
        this.input.isSanitized,
      );
    } catch (cause: unknown) {
      return this.classify(cause);
    }
  }

  private classify(cause: unknown): NativeExportValidation {
    return {
      ok: false,
      reason: cause instanceof BoundedJsonFault && cause.kind === "limit" ? "limit" : "malformed",
    };
  }
}
