export const expectedToolIds: readonly string[];
export const expectedPackedPathPolicy: Readonly<{ entryCount: number; sha256: string }>;
export function packedPathFingerprint(paths: readonly string[]): string;
export function assertSafePackedPath(path: string): void;
export function assertPackedSourceHasNoSymlink(root: string, packedPath: string): Promise<void>;
export function verifyPackage(root?: string): Promise<void>;
