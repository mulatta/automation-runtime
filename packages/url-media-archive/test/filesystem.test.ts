import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";

import {
  archiveFinalDir,
  assertSafeArchiveFinalDir,
  assertSafeDownloadTempDir,
  downloadTempDir,
  safeResolve,
} from "../src/archivePaths";
import {
  cleanupArchiveFinalDir,
  cleanupDownloadTempDir,
  storeFilesystemOutputs,
} from "../src/sinks/filesystem";

describe("archive filesystem paths", () => {
  it("keeps download temp directories under the archive temp root", () => {
    const root = mkdtempSync(join(tmpdir(), "url-media-archive-root-"));

    const tempDir = downloadTempDir(root, "pg:../../unsafe/status?123");

    expect(tempDir).toBe(join(root, ".tmp", "pg_.._.._unsafe_status_123"));
    expect(() => assertSafeDownloadTempDir(root, tempDir)).not.toThrow();
  });

  it("rejects archive path traversal", () => {
    const root = mkdtempSync(join(tmpdir(), "url-media-archive-root-"));

    expect(() => safeResolve(root, ["..", "outside"])).toThrow(
      "Refusing to access outside archive root",
    );
    expect(() => assertSafeDownloadTempDir(root, join(root, ".tmp"))).toThrow(
      "Refusing to delete unsafe download temp dir",
    );
    expect(() => assertSafeArchiveFinalDir(root, join(root, "db"))).toThrow(
      "Refusing to delete unsafe archive final dir",
    );
    expect(() =>
      assertSafeArchiveFinalDir(root, join(root, "db", "2026", "05")),
    ).toThrow("Refusing to delete unsafe archive final dir");
  });
});

describe("cleanupArchiveFinalDir", () => {
  it("removes only one job final directory and succeeds when absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "url-media-archive-root-"));
    const jobKey = "pg:018f6e9d-4a31-7565-982a-cb5e5f01d31f";
    const finalDir = archiveFinalDir(
      root,
      jobKey,
      "db",
      "2026-05-18T12:34:56.000Z",
    );
    mkdirSync(finalDir, { recursive: true });
    writeFileSync(join(finalDir, "orphan.mp4"), "partial");

    await cleanupArchiveFinalDir(root, jobKey, "2026-05-18T12:34:56.000Z");
    await cleanupArchiveFinalDir(root, jobKey, "2026-05-18T12:34:56.000Z");

    expect(existsSync(finalDir)).toBe(false);
    expect(existsSync(join(root, "db", "2026", "05"))).toBe(true);
  });
});

describe("cleanupDownloadTempDir", () => {
  it("removes nested temp files and succeeds when target is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "url-media-archive-root-"));
    const jobKey = "pg:018f6e9d-4a31-7565-982a-cb5e5f01d31f";
    const tempDir = downloadTempDir(root, jobKey);
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "download.part"), "partial");

    await cleanupDownloadTempDir(root, jobKey);
    await cleanupDownloadTempDir(root, jobKey);

    expect(existsSync(tempDir)).toBe(false);
  });
});

describe("storeFilesystemOutputs", () => {
  it("moves downloaded files into a stable safe archive path with sidecars", async () => {
    const root = mkdtempSync(join(tmpdir(), "url-media-archive-root-"));
    const tempDir = mkdtempSync(join(tmpdir(), "url-media-archive-download-"));
    const inputPath = join(tempDir, "unsafe title.mp4");
    writeFileSync(inputPath, "media bytes");

    const outputs = await storeFilesystemOutputs({
      archiveRoot: root,
      jobKey: "pg:018f6e9d-4a31-7565-982a-cb5e5f01d31f",
      mode: "db",
      canonicalUrl: "https://example.com/media/123",
      downloadedFiles: [inputPath],
      metadata: { id: "123", title: "Unsafe / Title", extractor: "test" },
      observedAt: "2026-05-18T12:34:56.000Z",
    });

    expect(outputs).toHaveLength(1);
    const [output] = outputs;
    expect(output.path).toBe(
      join(
        root,
        "db",
        "2026",
        "05",
        "018f6e9d-4a31-7565-982a-cb5e5f01d31f",
        "Unsafe _ Title [123].mp4",
      ),
    );
    expect(output.bytes).toBe(11);
    expect(output.sha256).toBe(
      "b6acae78c76442a73a94762eb91711a59c642ac3cfdaad636a061bdb7fad6975",
    );
    expect(readFileSync(output.path, "utf8")).toBe("media bytes");
    expect(
      JSON.parse(readFileSync(`${output.path}.info.json`, "utf8")) as unknown,
    ).toMatchObject({
      canonicalUrl: "https://example.com/media/123",
      jobKey: "pg:018f6e9d-4a31-7565-982a-cb5e5f01d31f",
      metadata: { id: "123", title: "Unsafe / Title" },
    });
    expect(readFileSync(`${output.path.slice(0, -4)}.nfo`, "utf8")).toContain(
      "<title>Unsafe / Title</title>",
    );
  });

  it("keeps long Unicode media filenames below filesystem byte limits", async () => {
    const root = mkdtempSync(join(tmpdir(), "url-media-archive-root-"));
    const tempDir = mkdtempSync(join(tmpdir(), "url-media-archive-download-"));
    const inputPath = join(tempDir, "fixture-video-id.mp4");
    const title = "Synthetic archive title 🧪 漢字 emoji mix ".repeat(12);
    writeFileSync(inputPath, "media bytes");

    const [output] = await storeFilesystemOutputs({
      archiveRoot: root,
      jobKey: "pg:018f6e9d-4a31-7565-982a-cb5e5f01d31f",
      mode: "db",
      canonicalUrl: "https://example.com/media/long-title-fixture",
      downloadedFiles: [inputPath],
      metadata: { id: "fixture-video-id", title, extractor: "test" },
      observedAt: "2026-05-18T12:34:56.000Z",
    });

    expect(Buffer.byteLength(basename(output.path))).toBeLessThanOrEqual(255);
    expect(readFileSync(`${output.path.slice(0, -4)}.nfo`, "utf8")).toContain(
      `<title>${title}</title>`,
    );
  });
});
