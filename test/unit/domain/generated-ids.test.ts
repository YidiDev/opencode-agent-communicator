import { describe, expect, test } from "bun:test";

import {
  createGeneratedIdFactory,
  generatedIdPolicy,
  validateDeliveryId,
  validateManagedSessionId,
  validateNativeMessageId,
  validateRequestId,
  validateStartOperationId,
} from "../../../src/domain/generated-ids";

describe("strict generated identifiers", () => {
  test("generates each brand from exactly 128 random bits in canonical lowercase hex", () => {
    const calls: number[] = [];
    const ids = createGeneratedIdFactory({
      randomBytes(length) {
        calls.push(length);
        return Uint8Array.from({ length }, (_, index) => index);
      },
    });
    expect(String(ids.deliveryId())).toBe("dlv_000102030405060708090a0b0c0d0e0f");
    expect(String(ids.nativeMessageId())).toBe("msg_000102030405060708090a0b0c0d0e0f");
    expect(String(ids.requestId())).toBe("req_000102030405060708090a0b0c0d0e0f");
    expect(String(ids.managedSessionId())).toBe("ses_000102030405060708090a0b0c0d0e0f");
    expect(String(ids.startOperationId())).toBe("op_000102030405060708090a0b0c0d0e0f");
    expect(calls).toEqual([16, 16, 16, 16, 16]);
    expect(generatedIdPolicy.randomBytes * 8).toBe(128);
  });

  test("validates only the exact prefix, length, character set, and canonical case", () => {
    const hex = "0123456789abcdef0123456789abcdef";
    expect(validateDeliveryId(`dlv_${hex}`).ok).toBe(true);
    expect(validateNativeMessageId(`msg_${hex}`).ok).toBe(true);
    expect(validateRequestId(`req_${hex}`).ok).toBe(true);
    expect(validateManagedSessionId(`ses_${hex}`).ok).toBe(true);
    expect(validateStartOperationId(`op_${hex}`).ok).toBe(true);
    expect(validateNativeMessageId(`msg_${hex.toUpperCase()}`).ok).toBe(false);
    expect(validateRequestId(`req_${hex.slice(1)}`).ok).toBe(false);
    expect(validateManagedSessionId(`ses_${hex}0`).ok).toBe(false);
    expect(validateStartOperationId(`start_${hex}`).ok).toBe(false);
    for (const malformed of [
      `dlv_${hex.slice(1)}`,
      `dlv_${hex}0`,
      `dlv_${hex.toUpperCase()}`,
      `dlv_${"g".repeat(32)}`,
      `msg_${hex}`,
      `dlv_${hex}\n`,
      42,
    ]) {
      expect(validateDeliveryId(malformed).ok).toBe(false);
    }
  });

  test("fails closed when the entropy implementation violates its contract", () => {
    const ids = createGeneratedIdFactory({ randomBytes: () => new Uint8Array(15) });
    expect(() => ids.deliveryId()).toThrow("128-bit");
    expect(() => ids.nativeMessageId()).toThrow("128-bit");
    expect(() => ids.requestId()).toThrow("128-bit");
    expect(() => ids.managedSessionId()).toThrow("128-bit");
    expect(() => ids.startOperationId()).toThrow("128-bit");
  });
});
