export type WorkspaceKey = string & { readonly workspaceKey: unique symbol };

export type WorkspaceKeyValidation =
  | { readonly ok: true; readonly value: WorkspaceKey }
  | { readonly ok: false; readonly message: string };

export function validateWorkspaceKey(value: unknown): WorkspaceKeyValidation {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    return { ok: false, message: "Workspace key is malformed." };
  }
  return { ok: true, value: value as WorkspaceKey };
}
