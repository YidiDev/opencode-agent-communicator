/**
 * Best-effort observation for ordinary genuine native Promise contract violations. Non-native
 * thenables are never assimilated. Malicious mutation of Promise internals is outside the exact
 * synchronous callback contracts that use this helper (the intrinsic then may still species-read).
 */
export function observeNativePromiseRejection(value: unknown): void {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
  try {
    void Promise.prototype.then.call(value, undefined, () => undefined);
  } catch {
    // The intrinsic brand check rejects non-native thenables without consulting their properties.
  }
}
