export type ObjectPhase = "key_or_end" | "key" | "colon" | "value" | "comma_or_end";
export type ArrayPhase = "value_or_end" | "value" | "comma_or_end";
export type JsonFrame =
  | {
      readonly kind: "object";
      readonly value: Record<string, unknown>;
      phase: ObjectPhase;
      key?: string;
    }
  | { readonly kind: "array"; readonly value: unknown[]; phase: ArrayPhase };
export type JsonToken = "none" | "string" | "escape" | "unicode" | "number" | "literal";

export class BoundedJsonFault extends Error {
  override readonly name = "BoundedJsonFault";
  constructor(readonly kind: "malformed" | "limit") {
    super("Bounded JSON validation failed.");
  }
}
