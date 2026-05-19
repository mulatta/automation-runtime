import { replaceLoneSurrogates } from "../json";

export type JellyfinNfoInput = {
  title?: string;
  canonicalUrl: string;
  metadata?: Record<string, unknown>;
};

export function buildJellyfinNfo(input: JellyfinNfoInput): string {
  const title = stringValue(input.title) ?? stringValue(input.metadata?.title);
  const mediaId = stringValue(input.metadata?.id);
  const extractor =
    stringValue(input.metadata?.extractorKey) ??
    stringValue(input.metadata?.extractor) ??
    "source";
  const webpageUrl =
    stringValue(input.metadata?.webpageUrl) ??
    stringValue(input.metadata?.webpage_url) ??
    stringValue(input.metadata?.originalUrl) ??
    stringValue(input.metadata?.original_url) ??
    input.canonicalUrl;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    "<movie>",
  ];
  if (title) {
    lines.push(`  <title>${escapeXmlText(title)}</title>`);
    lines.push(`  <originaltitle>${escapeXmlText(title)}</originaltitle>`);
  }
  if (mediaId) {
    lines.push(
      `  <uniqueid type="${escapeXmlAttribute(extractor)}" default="true">${escapeXmlText(mediaId)}</uniqueid>`,
    );
  }
  lines.push(`  <plot>${escapeXmlText(webpageUrl)}</plot>`);
  lines.push("</movie>", "");
  return lines.join("\n");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function escapeXmlText(value: string): string {
  return replaceLoneSurrogates(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
