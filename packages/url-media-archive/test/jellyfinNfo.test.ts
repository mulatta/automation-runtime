import { buildJellyfinNfo } from "../src/sinks/jellyfinNfo";

describe("buildJellyfinNfo", () => {
  it("writes Jellyfin-compatible title metadata", () => {
    expect(
      buildJellyfinNfo({
        canonicalUrl: "https://example.com/media/123?utm_source=test",
        metadata: {
          id: "123",
          title: "Long & Original <Title> 😀",
          extractor: "test",
        },
      }),
    ).toContain("<title>Long &amp; Original &lt;Title&gt; 😀</title>");
  });

  it("sanitizes invalid unicode for XML readers", () => {
    expect(
      buildJellyfinNfo({
        canonicalUrl: "https://example.com/media/123",
        metadata: { id: "123", title: "broken \ud835 title" },
      }),
    ).toContain("<title>broken � title</title>");
  });
});
