import { isAbsolute, relative, resolve } from "path";

export type ArchiveStorageMode = "db" | "url";

export function downloadTempDir(archiveRoot: string, jobKey: string): string {
  return safeResolve(archiveRoot, [".tmp", safeJobKey(jobKey)]);
}

export function archiveFinalDir(
  archiveRoot: string,
  jobKey: string,
  mode: ArchiveStorageMode,
  observedAt: string,
): string {
  const observed = parseObservedAt(observedAt);
  const id = safePathSegment(jobKey.split(":").slice(1).join(":"));
  return safeResolve(archiveRoot, [
    mode,
    observed.year,
    observed.month,
    id || safePathSegment(jobKey),
  ]);
}

export function safeJobKey(jobKey: string): string {
  return jobKey.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function safeResolve(root: string, parts: readonly string[]): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, ...parts);
  if (!isWithinOrEqual(resolvedRoot, resolved)) {
    throw new Error(`Refusing to access outside archive root: ${resolved}`);
  }
  return resolved;
}

export function assertSafeDownloadTempDir(
  archiveRoot: string,
  path: string,
): void {
  const resolvedRoot = resolve(archiveRoot);
  const resolvedTempRoot = safeResolve(resolvedRoot, [".tmp"]);
  const resolvedPath = resolve(path);
  if (
    resolvedPath === resolvedRoot ||
    resolvedPath === resolvedTempRoot ||
    !isWithin(resolvedTempRoot, resolvedPath)
  ) {
    throw new Error(`Refusing to delete unsafe download temp dir: ${path}`);
  }
}

export function assertSafeArchiveFinalDir(
  archiveRoot: string,
  path: string,
): void {
  const resolvedRoot = resolve(archiveRoot);
  const resolvedDbRoot = safeResolve(resolvedRoot, ["db"]);
  const resolvedPath = resolve(path);
  if (
    resolvedPath === resolvedRoot ||
    resolvedPath === resolvedDbRoot ||
    !isWithin(resolvedDbRoot, resolvedPath) ||
    relative(resolvedDbRoot, resolvedPath).split(/[\\/]/).length !== 3
  ) {
    throw new Error(`Refusing to delete unsafe archive final dir: ${path}`);
  }
}

function parseObservedAt(value: string): { year: string; month: string } {
  const match = /^(?<year>\d{4})-(?<month>\d{2})-/.exec(value);
  return {
    year: match?.groups?.year ?? "unknown",
    month: match?.groups?.month ?? "unknown",
  };
}

function safePathSegment(segment: string): string {
  return safeFilename(segment).replace(/[:]/g, "_");
}

function safeFilename(name: string): string {
  const cleaned = Array.from(name, (char) =>
    isUnsafeFilenameChar(char) ? "_" : char,
  )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned === "." || cleaned === ".." ? "media.bin" : cleaned;
}

function isUnsafeFilenameChar(char: string): boolean {
  return char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char);
}

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function isWithinOrEqual(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
