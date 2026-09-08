import { createHash, type Hash } from "node:crypto";

import type { Sha256Digest } from "../../domain/message-payload";
import type { SessionId } from "../../domain/sessions";
import type { LinuxExportTemporary } from "./linux-export-destination";
import { NativeExportStreamValidator } from "./native-export-stream-validation";
import type { NativeExportValidation } from "./native-export-validation";

interface NativeExportCaptureInput {
  readonly temporary: LinuxExportTemporary;
  readonly sessionId: SessionId;
  readonly isSanitized: boolean;
  readonly deadlineMs: number;
}

type NativeExportFailure = Extract<NativeExportValidation, { readonly ok: false }>;

/** Owns the single-pass write, digest, byte count, and bounded validation of native stdout. */
export class NativeExportCapture {
  private readonly hash: Hash = createHash("sha256");
  private readonly validator: NativeExportStreamValidator;
  private byteCount = 0;

  constructor(private readonly input: NativeExportCaptureInput) {
    this.validator = new NativeExportStreamValidator(input);
  }

  write(chunk: Uint8Array): void {
    this.input.temporary.write(chunk);
    this.hash.update(chunk);
    this.byteCount += chunk.byteLength;
    this.validator.feed(chunk);
  }

  finish():
    | { readonly ok: false; readonly validation: NativeExportFailure }
    | { readonly ok: true; readonly byteCount: number; readonly digest: Sha256Digest } {
    const validation = this.validator.finish();
    if (!validation.ok) return { ok: false, validation };
    return {
      ok: true,
      byteCount: this.byteCount,
      digest: this.hash.digest("hex") as Sha256Digest,
    };
  }
}
