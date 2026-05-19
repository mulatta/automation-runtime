import { canonicalizeUrl, jobIdFromJobKey, jobKeyForJobId } from "../src/ids";

describe("archive IDs", () => {
  it("canonicalizes URLs for stable deduplication", () => {
    expect(
      canonicalizeUrl("HTTPS://Example.COM:443/media/123?utm_source=test#frag"),
    ).toBe("https://example.com/media/123");
    expect(
      canonicalizeUrl("https://example.com:443/path?a=1&utm_medium=social"),
    ).toBe("https://example.com/path?a=1");
  });

  it("builds database-backed job keys", () => {
    expect(jobKeyForJobId("018f6e9d-4a31-7565-982a-cb5e5f01d31f")).toBe(
      "pg:018f6e9d-4a31-7565-982a-cb5e5f01d31f",
    );
  });

  it("extracts database job IDs from DB-backed job keys", () => {
    expect(jobIdFromJobKey("pg:018F6E9D-4A31-7565-982A-CB5E5F01D31F")).toBe(
      "018f6e9d-4a31-7565-982a-cb5e5f01d31f",
    );
    expect(jobIdFromJobKey("url:abc")).toBeNull();
    expect(jobIdFromJobKey("pg:not-a-uuid")).toBeNull();
  });
});
