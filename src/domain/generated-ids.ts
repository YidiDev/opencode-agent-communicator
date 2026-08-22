import type { SessionId } from "./sessions";

export type DeliveryId = string & { readonly deliveryId: unique symbol };
export type NativeMessageId = string & { readonly nativeMessageId: unique symbol };
export type RequestId = string & { readonly requestId: unique symbol };
export type StartOperationId = string & { readonly startOperationId: unique symbol };

export const generatedIdPolicy = {
  randomBytes: 16,
  encodedCharacters: 32,
  encoding: "lowercase hexadecimal",
  prefixes: {
    delivery: "dlv_",
    nativeMessage: "msg_",
    request: "req_",
    managedSession: "ses_",
    startOperation: "op_",
  },
} as const;

type GeneratedId = DeliveryId | NativeMessageId | RequestId | SessionId | StartOperationId;
type Validation<Value extends GeneratedId> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly message: string };

export interface CryptographicEntropyPort {
  /** Implementations must return cryptographically secure random bytes. */
  randomBytes(length: number): Uint8Array;
}

export interface GeneratedIdFactory {
  deliveryId(): DeliveryId;
  nativeMessageId(): NativeMessageId;
  requestId(): RequestId;
  managedSessionId(): SessionId;
  startOperationId(): StartOperationId;
}

function validate<Value extends GeneratedId>(
  value: unknown,
  prefix: string,
  label: string,
): Validation<Value> {
  const expression = new RegExp(`^${prefix}[0-9a-f]{${generatedIdPolicy.encodedCharacters}}$`);
  return typeof value === "string" && expression.test(value)
    ? { ok: true, value: value as Value }
    : { ok: false, message: `${label} is malformed.` };
}

export function validateDeliveryId(value: unknown): Validation<DeliveryId> {
  return validate(value, generatedIdPolicy.prefixes.delivery, "Delivery ID");
}

export function validateNativeMessageId(value: unknown): Validation<NativeMessageId> {
  return validate(value, generatedIdPolicy.prefixes.nativeMessage, "Native message ID");
}

export function validateRequestId(value: unknown): Validation<RequestId> {
  return validate(value, generatedIdPolicy.prefixes.request, "Request ID");
}

export function validateManagedSessionId(value: unknown): Validation<SessionId> {
  return validate(value, generatedIdPolicy.prefixes.managedSession, "Managed session ID");
}

export function validateStartOperationId(value: unknown): Validation<StartOperationId> {
  return validate(value, generatedIdPolicy.prefixes.startOperation, "Start operation ID");
}

function encodeRandom(entropy: CryptographicEntropyPort, prefix: string): string {
  const bytes = entropy.randomBytes(generatedIdPolicy.randomBytes);
  if (!(bytes instanceof Uint8Array) || bytes.length !== generatedIdPolicy.randomBytes) {
    throw new Error("The entropy port violated its 128-bit output contract.");
  }
  let encoded = prefix;
  for (const byte of bytes) encoded += byte.toString(16).padStart(2, "0");
  return encoded;
}

export function createGeneratedIdFactory(entropy: CryptographicEntropyPort): GeneratedIdFactory {
  return {
    deliveryId: () => encodeRandom(entropy, generatedIdPolicy.prefixes.delivery) as DeliveryId,
    nativeMessageId: () =>
      encodeRandom(entropy, generatedIdPolicy.prefixes.nativeMessage) as NativeMessageId,
    requestId: () => encodeRandom(entropy, generatedIdPolicy.prefixes.request) as RequestId,
    managedSessionId: () =>
      encodeRandom(entropy, generatedIdPolicy.prefixes.managedSession) as SessionId,
    startOperationId: () =>
      encodeRandom(entropy, generatedIdPolicy.prefixes.startOperation) as StartOperationId,
  };
}
