import { buildJellyfinNfo } from "../src/sinks/jellyfinNfo";

describe("buildJellyfinNfo", () => {
  it("writes Jellyfin-compatible title metadata", () => {
    const nfo = buildJellyfinNfo({
      canonicalUrl: "https://example.com/media/123?utm_source=test",
      metadata: {
        id: "123",
        title: "Long & Original <Title> 😀",
        extractor: "test",
      },
    });

    expect(nfo).toContain(
      "<title>Long &amp; Original &lt;Title&gt; 😀</title>",
    );
    expect(nfo).toContain(
      '<uniqueid type="url-media" default="true">123</uniqueid>',
    );
  });

  it("sanitizes invalid unicode for XML readers", () => {
    expect(
      buildJellyfinNfo({
        canonicalUrl: "https://example.com/media/123",
        metadata: { id: "123", title: "broken \ud835 title" },
      }),
    ).toContain("<title>broken � title</title>");
  });

  it("adds neutral creator and date fields for Jellyfin filters", () => {
    const nfo = buildJellyfinNfo({
      canonicalUrl: "https://example.com/media/123",
      metadata: {
        id: "123",
        title: "Creator &gt; encoded",
        uploader: "Example Creator",
        upload_date: "20260519",
      },
    });

    expect(nfo).toContain("<title>Creator &gt; encoded</title>");
    expect(nfo).toContain("<studio>Example Creator</studio>");
    expect(nfo).toContain("<tag>creator: Example Creator</tag>");
    expect(nfo).toContain("<premiered>2026-05-19</premiered>");
    expect(nfo).toContain("<year>2026</year>");
  });
});
