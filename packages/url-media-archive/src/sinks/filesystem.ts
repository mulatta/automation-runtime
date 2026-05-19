import { createReadStream } from "fs";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "fs/promises";
import { createBLAKE3 } from "hash-wasm";
import { basename, extname } from "path";

import {
  archiveFinalDir,
  assertSafeArchiveFinalDir,
  assertSafeDownloadTempDir,
  downloadTempDir,
  safeResolve,
} from "../archivePaths";
import type { ArchiveOutputInput } from "../db";
import { buildJellyfinNfo } from "./jellyfinNfo";

const MAX_FINAL_FILENAME_BYTES = 180;
const MAX_MEDIA_ID_BYTES = 80;

export type StoreFilesystemOutputsInput = {
  archiveRoot: string;
  jobKey: string;
  mode: "db" | "url";
  canonicalUrl: string;
  downloadedFiles: readonly string[];
  metadata?: Record<string, unknown>;
  observedAt: string;
};

export async function storeFilesystemOutputs(
  input: StoreFilesystemOutputsInput,
): Promise<ArchiveOutputInput[]> {
  const targetDir = targetDirectory(input);
  await mkdir(targetDir, { recursive: true });

  const outputs: ArchiveOutputInput[] = [];
  const usedNames = new Set<string>();
  for (const downloadedFile of input.downloadedFiles) {
    const targetPath = await uniqueTargetPath(
      targetDir,
      finalMediaFilename(downloadedFile, input.metadata),
      usedNames,
    );
    await moveFile(downloadedFile, targetPath);
    const fileStat = await stat(targetPath);
    const blake3 = await blake3File(targetPath);
    const output: ArchiveOutputInput = {
      path: targetPath,
      bytes: fileStat.size,
      blake3,
      mimeType: mimeTypeFromPath(targetPath),
      metadata: {
        ...input.metadata,
        canonicalUrl: input.canonicalUrl,
        jobKey: input.jobKey,
        archivedAt: input.observedAt,
      },
    };
    await writeSidecar(targetPath, input, output);
    await writeJellyfinNfo(targetPath, input);
    outputs.push(output);
  }

  return outputs;
}

export async function cleanupDownloadTempDir(
  archiveRoot: string,
  jobKey: string,
): Promise<void> {
  const target = downloadTempDir(archiveRoot, jobKey);
  assertSafeDownloadTempDir(archiveRoot, target);
  await rm(target, { recursive: true, force: true });
}

export async function cleanupArchiveFinalDir(
  archiveRoot: string,
  jobKey: string,
  observedAt: string,
): Promise<void> {
  const target = archiveFinalDir(archiveRoot, jobKey, "db", observedAt);
  assertSafeArchiveFinalDir(archiveRoot, target);
  await rm(target, { recursive: true, force: true });
}

function targetDirectory(input: StoreFilesystemOutputsInput): string {
  return archiveFinalDir(
    input.archiveRoot,
    input.jobKey,
    input.mode,
    input.observedAt,
  );
}

async function uniqueTargetPath(
  dir: string,
  filename: string,
  usedNames: Set<string>,
): Promise<string> {
  const fallback = truncateFilenameBytes(filename || "media.bin");
  const extension = extname(fallback);
  const stem = extension ? fallback.slice(0, -extension.length) : fallback;

  for (let index = 0; ; index += 1) {
    const suffix = index === 0 ? "" : `-${index}`;
    const candidateName = buildFilename(stem, suffix, extension);
    if (usedNames.has(candidateName)) continue;
    const candidatePath = safeResolve(dir, [candidateName]);
    try {
      await stat(candidatePath);
    } catch (error) {
      if (isNotFound(error)) {
        usedNames.add(candidateName);
        return candidatePath;
      }
      throw error;
    }
  }
}

async function moveFile(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
  } catch (error) {
    if (!isCrossDevice(error)) throw error;
    await copyFile(source, target);
    await rm(source, { force: true });
  }
}

async function writeSidecar(
  targetPath: string,
  input: StoreFilesystemOutputsInput,
  output: ArchiveOutputInput,
): Promise<void> {
  await writeFile(
    `${targetPath}.info.json`,
    `${JSON.stringify(
      {
        canonicalUrl: input.canonicalUrl,
        jobKey: input.jobKey,
        archivedAt: input.observedAt,
        path: output.path,
        bytes: output.bytes,
        blake3: output.blake3,
        mimeType: output.mimeType,
        metadata: input.metadata ?? {},
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function writeJellyfinNfo(
  targetPath: string,
  input: StoreFilesystemOutputsInput,
): Promise<void> {
  await writeFile(
    nfoPathForMedia(targetPath),
    buildJellyfinNfo({
      canonicalUrl: input.canonicalUrl,
      metadata: input.metadata,
    }),
    "utf8",
  );
}

async function blake3File(path: string): Promise<string> {
  const hasher = await createBLAKE3();
  const stream: AsyncIterable<Buffer> = createReadStream(path);
  for await (const chunk of stream) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}

function finalMediaFilename(
  downloadedFile: string,
  metadata: Record<string, unknown> | undefined,
): string {
  const extension = safeExtension(downloadedFile);
  const title = stringMetadata(metadata, "title");
  const mediaId = stringMetadata(metadata, "id");
  if (!title)
    return truncateFilenameBytes(safeFilename(basename(downloadedFile)));

  const safeId = mediaId
    ? truncateUtf8Bytes(safeFilename(mediaId), MAX_MEDIA_ID_BYTES)
    : undefined;
  const idSuffix = safeId ? ` [${safeId}]` : "";
  return buildFilename(safeFilename(title), idSuffix, extension);
}

function nfoPathForMedia(path: string): string {
  const extension = extname(path);
  return extension ? `${path.slice(0, -extension.length)}.nfo` : `${path}.nfo`;
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildFilename(
  stem: string,
  suffix: string,
  extension: string,
  maxBytes = MAX_FINAL_FILENAME_BYTES,
): string {
  const suffixBytes = Buffer.byteLength(suffix);
  const extensionBytes = Buffer.byteLength(extension);
  const stemBudget = Math.max(1, maxBytes - suffixBytes - extensionBytes);
  const safeStem = truncateUtf8Bytes(stem, stemBudget) || "media";
  return `${safeStem}${suffix}${extension}`;
}

function truncateFilenameBytes(
  filename: string,
  maxBytes = MAX_FINAL_FILENAME_BYTES,
): string {
  const extension = safeExtension(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  return buildFilename(stem, "", extension, maxBytes);
}

function safeExtension(path: string): string {
  const extension = extname(path);
  if (!extension) return ".bin";
  const safe = safeFilename(extension);
  return safe.startsWith(".") ? safe : `.${safe}`;
}

function truncateUtf8Bytes(value: string, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char);
    if (bytes + charBytes > maxBytes) break;
    output += char;
    bytes += charBytes;
  }
  return output.trim();
}

function safeFilename(name: string): string {
  const cleaned = Array.from(name, (char) =>
    isUnsafeFilenameChar(char) ? "_" : char,
  )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned === "." || cleaned === ".." ? "media" : cleaned;
}

function isUnsafeFilenameChar(char: string): boolean {
  return char.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(char);
}

function mimeTypeFromPath(path: string): string | undefined {
  switch (extname(path).toLowerCase()) {
    case ".mp4":
      return "video/mp4";
    case ".m4a":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".webm":
      return "video/webm";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    default:
      return undefined;
  }
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isCrossDevice(error: unknown): boolean {
  return isNodeError(error) && error.code === "EXDEV";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
