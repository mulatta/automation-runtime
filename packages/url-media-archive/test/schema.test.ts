import {
  DrainPendingRequest,
  UrlMediaJobRunRequest,
  StatusBySourceRequest,
  SubmitDiscoveredUrlRequest,
  SubmitJobRequest,
  SubmitUrlRequest,
} from "../src/schema";

describe("url-media-archive schemas", () => {
  it("parses discovered URL input from source-specific producers", () => {
    expect(
      SubmitDiscoveredUrlRequest.parse({
        source: "example-feed",
        sourceKey: "12345",
        url: "https://example.com/media/12345",
        sourceCreatedAt: "2026-05-18T12:34:56.000Z",
        metadata: { author: "example-user", text: "hello" },
      }),
    ).toEqual({
      source: "example-feed",
      sourceKey: "12345",
      url: "https://example.com/media/12345",
      sourceCreatedAt: "2026-05-18T12:34:56.000Z",
      metadata: { author: "example-user", text: "hello" },
    });
  });

  it("rejects unknown fields at Restate boundaries", () => {
    expect(() =>
      SubmitJobRequest.parse({ jobId: crypto.randomUUID(), extra: true }),
    ).toThrow();
  });

  it("defaults drain requests", () => {
    expect(DrainPendingRequest.parse({})).toEqual({
      limit: 25,
      statuses: ["pending", "failed"],
    });
  });

  it("allows only DB-backed media job runs", () => {
    expect(() =>
      UrlMediaJobRunRequest.parse({
        mode: "url",
        url: "https://example.com/video",
        canonicalUrl: "https://example.com/video",
      }),
    ).toThrow();
  });

  it("validates direct URL and status inputs", () => {
    expect(
      SubmitUrlRequest.parse({ url: "https://example.com/video" }),
    ).toEqual({ url: "https://example.com/video" });

    expect(
      StatusBySourceRequest.parse({ source: "example-feed", sourceKey: "123" }),
    ).toEqual({ source: "example-feed", sourceKey: "123" });
  });
});
