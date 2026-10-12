import type { z } from "zod";
import type { DomainFailureCode, DomainResult } from "../domain/results";

export interface StructuralToolContext {
  readonly sessionID: string;
  readonly abort: AbortSignal;
  readonly messageID?: string;
  readonly [legacyHostField: string]: unknown;
}

export interface InternalToolContract<Arguments> {
  readonly description: string;
  readonly args: z.ZodType<Arguments>;
  execute(arguments_: Arguments, context: StructuralToolContext): Promise<string>;
}

export class ToolContractFault extends Error {
  override readonly name = "ToolContractFault";

  constructor() {
    super("Application returned an undeclared tool outcome.");
  }
}

export function serializeDomainResult<Input, Output>(
  result: DomainResult<Input>,
  mapValue: (value: Input) => Output,
  allowedFailureCodes: readonly DomainFailureCode[],
): string {
  if (result.ok) return JSON.stringify({ ok: true, value: mapValue(result.value) });
  if (allowedFailureCodes.includes(result.error.code)) return JSON.stringify(result);
  throw new ToolContractFault();
}
