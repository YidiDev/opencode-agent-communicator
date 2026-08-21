export type FencingToken = number & { readonly fencingToken: unique symbol };

/** Domain-safe ownership fault used across port boundaries without adapter coupling. */
export class OwnershipLostFault extends Error {
  override readonly name: string = "OwnershipLostFault";
}

export type FencingTokenValidation =
  | { readonly ok: true; readonly value: FencingToken }
  | { readonly ok: false; readonly message: string };

export function validateFencingToken(value: unknown): FencingTokenValidation {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return { ok: false, message: "Fencing token must be a positive safe-integer epoch." };
  }
  return { ok: true, value: value as FencingToken };
}
