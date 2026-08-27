import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { validateWorkspaceKey, type WorkspaceKey } from "../domain/workspaces";

function projectIdentity(project: unknown): string {
  if (typeof project !== "object" || project === null)
    throw new TypeError("Project identity is unavailable.");
  const id: unknown = Reflect.get(project, "id");
  if (typeof id !== "string" || id.length < 1 || id.length > 512) {
    throw new TypeError("Project identity is malformed.");
  }
  return id;
}

/** The persisted key contains only a digest; canonical local paths never appear in identifiers. */
export function deriveWorkspaceKey(input: {
  readonly project: unknown;
  readonly worktree: string;
  readonly directory: string;
}): WorkspaceKey {
  return deriveWorkspaceBinding(input).workspaceKey;
}

export interface WorkspaceBinding {
  readonly workspaceKey: WorkspaceKey;
  readonly projectId: string;
  readonly directory: string;
  readonly worktree: string;
}

function contained(worktree: string, directory: string): boolean {
  const value = relative(worktree, directory);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

export function deriveWorkspaceBinding(input: {
  readonly project: unknown;
  readonly worktree: string;
  readonly directory: string;
}): WorkspaceBinding {
  if (!isAbsolute(input.worktree) || !isAbsolute(input.directory)) {
    throw new TypeError("Workspace paths must be absolute.");
  }
  const canonical = {
    project: projectIdentity(input.project),
    worktree: realpathSync(input.worktree),
    directory: realpathSync(input.directory),
  };
  if (!contained(canonical.worktree, canonical.directory)) {
    throw new TypeError("Workspace directory must be contained by its worktree.");
  }
  const candidate = `wrk_${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
  const validated = validateWorkspaceKey(candidate);
  if (!validated.ok) throw new TypeError(validated.message);
  return Object.freeze({
    workspaceKey: validated.value,
    projectId: canonical.project,
    directory: canonical.directory,
    worktree: canonical.worktree,
  });
}
