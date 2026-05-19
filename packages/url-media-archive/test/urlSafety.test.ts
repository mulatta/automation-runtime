import { assertSafeArchiveUrl } from "../src/urlSafety";

describe("URL safety", () => {
  it("allows public http and https URLs", () => {
    expect(
      assertSafeArchiveUrl("https://example.com/media/123"),
    ).toBeUndefined();
    expect(assertSafeArchiveUrl("http://example.com/video")).toBeUndefined();
  });

  it("rejects unsupported schemes", () => {
    expect(() => assertSafeArchiveUrl("file:///etc/passwd")).toThrow(
      /unsupported URL scheme/,
    );
    expect(() => assertSafeArchiveUrl("ftp://example.com/file")).toThrow(
      /unsupported URL scheme/,
    );
  });

  it("rejects localhost and private IP literals", () => {
    for (const url of [
      "http://localhost:8080/",
      "http://127.0.0.1/",
      "http://10.0.0.1/",
      "http://172.16.0.1/",
      "http://192.168.1.10/",
      "http://169.254.1.1/",
      "http://[::1]/",
      "http://[fc00::1]/",
    ]) {
      expect(() => assertSafeArchiveUrl(url)).toThrow(/private or local/);
    }
  });
});
