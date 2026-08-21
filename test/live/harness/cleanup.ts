export type CleanupAction = () => void | Promise<void>;

export async function cleanupAll(
  actions: readonly CleanupAction[],
  initialFailure?: unknown,
): Promise<void> {
  let firstFailure = initialFailure;
  for (const action of actions) {
    try {
      await action();
    } catch (error: unknown) {
      firstFailure ??= error;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}
