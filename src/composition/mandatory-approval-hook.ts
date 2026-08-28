import type { Permission } from "@opencode-ai/sdk";

type PermissionStatus = { status: "ask" | "deny" | "allow" };

const permissionActions = new Set(["allow", "ask", "deny"]);
const enforcementError = "Mandatory OpenCode permission configuration could not be enforced.";
const malformedError = "OpenCode permission configuration is malformed.";

function failMalformed(): never {
  throw new TypeError(malformedError);
}

function isPermissionAction(value: unknown): value is "allow" | "ask" | "deny" {
  return typeof value === "string" && permissionActions.has(value);
}

function ownDataEntries(value: unknown): ReadonlyArray<readonly [string, unknown]> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return failMalformed();
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return failMalformed();
    return keys.map((key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return failMalformed();
      return [key as string, descriptor.value] as const;
    });
  } catch (cause) {
    if (cause instanceof TypeError && cause.message === malformedError) throw cause;
    return failMalformed();
  }
}

function validatePermissionObject(value: unknown): asserts value is object {
  for (const [, rule] of ownDataEntries(value)) {
    if (isPermissionAction(rule)) continue;
    for (const [, action] of ownDataEntries(rule)) {
      if (!isPermissionAction(action)) failMalformed();
    }
  }
}

function ownDataValue(
  target: object,
  key: string,
): { readonly exists: boolean; readonly value?: unknown } {
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    if (!descriptor) return { exists: false };
    if (!("value" in descriptor)) return failMalformed();
    return { exists: true, value: descriptor.value };
  } catch (cause) {
    if (cause instanceof TypeError && cause.message === malformedError) throw cause;
    return failMalformed();
  }
}

function hasInheritedProperty(target: object, key: string): boolean {
  let prototype = Object.getPrototypeOf(target);
  while (prototype !== null) {
    if (Reflect.getOwnPropertyDescriptor(prototype, key)) return true;
    prototype = Object.getPrototypeOf(prototype);
  }
  return false;
}

function enforceOwnDataProperty(target: object, key: string, value: unknown): void {
  try {
    const before = Reflect.getOwnPropertyDescriptor(target, key);
    if (before && (!("value" in before) || !before.writable)) throw new Error(enforcementError);
    if (!before && (!Object.isExtensible(target) || hasInheritedProperty(target, key))) {
      throw new Error(enforcementError);
    }
    const descriptor: PropertyDescriptor = before
      ? { value }
      : { value, writable: true, enumerable: true, configurable: true };
    if (!Reflect.defineProperty(target, key, descriptor)) throw new Error(enforcementError);

    const after = Reflect.getOwnPropertyDescriptor(target, key);
    if (
      !after ||
      !("value" in after) ||
      after.value !== value ||
      !Object.hasOwn(target, key) ||
      Reflect.get(target, key, target) !== value
    ) {
      throw new Error(enforcementError);
    }
  } catch {
    throw new TypeError(enforcementError);
  }
}

/** Ensure host policy evaluation reaches the ask hook; OpenCode 1.18 skips it for pre-allowed calls. */
export function enforceMandatoryStopConfiguration(config: object): void {
  let permission: ReturnType<typeof ownDataValue>;
  try {
    if (Object.getPrototypeOf(config) !== Object.prototype) failMalformed();
    permission = ownDataValue(config, "permission");
  } catch (cause) {
    if (cause instanceof TypeError) throw cause;
    failMalformed();
  }
  const current = permission.value;
  if (!permission.exists || current === undefined) {
    enforceOwnDataProperty(config, "permission", { session_stop: "ask" });
    return;
  }
  if (typeof current === "string") {
    if (!isPermissionAction(current)) failMalformed();
    enforceOwnDataProperty(config, "permission", { "*": current, session_stop: "ask" });
    return;
  }
  validatePermissionObject(current);
  enforceOwnDataProperty(current, "session_stop", "ask");
}

/** Stop is destructive, so inherited allow rules are deliberately narrowed back to ask. */
export async function enforceMandatoryApproval(
  input: Permission,
  output: PermissionStatus,
): Promise<void> {
  if (input.type === "session_stop" && output.status === "allow") output.status = "ask";
}
