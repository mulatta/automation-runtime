import { replaceLoneSurrogates } from "../json";

export type JellyfinNfoInput = {
  title?: string;
  canonicalUrl: string;
  metadata?: Record<string, unknown>;
};

export function buildJellyfinNfo(input: JellyfinNfoInput): string {
  const title = decodeHtmlEntities(
    stringValue(input.title) ?? stringValue(input.metadata?.title),
  );
  const mediaId = stringValue(input.metadata?.id);
  const creator = decodeHtmlEntities(
    firstStringMetadata(input.metadata, [
      "uploader",
      "channel",
      "creator",
      "uploader_id",
      "channel_id",
    ]) ?? creatorFromTitle(title),
  );
  const premiered = dateFromMetadata(input.metadata);
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
      `  <uniqueid type="url-media" default="true">${escapeXmlText(mediaId)}</uniqueid>`,
    );
  }
  if (premiered) {
    lines.push(`  <premiered>${escapeXmlText(premiered)}</premiered>`);
    lines.push(`  <releasedate>${escapeXmlText(premiered)}</releasedate>`);
    lines.push(`  <year>${escapeXmlText(premiered.slice(0, 4))}</year>`);
  }
  if (creator) {
    lines.push(`  <studio>${escapeXmlText(creator)}</studio>`);
    lines.push(`  <tag>${escapeXmlText(`creator: ${creator}`)}</tag>`);
  }
  lines.push("  <tag>url-media</tag>");
  lines.push(`  <plot>${escapeXmlText(webpageUrl)}</plot>`);
  lines.push("</movie>", "");
  return lines.join("\n");
}

function firstStringMetadata(
  metadata: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = stringValue(metadata?.[key]);
    if (value) return value;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function creatorFromTitle(title: string | undefined): string | undefined {
  const separator = " - ";
  const separatorIndex = title?.indexOf(separator) ?? -1;
  if (separatorIndex <= 0) return undefined;
  return title?.slice(0, separatorIndex).trim() || undefined;
}

function dateFromMetadata(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const uploadDate = stringValue(metadata?.upload_date);
  if (uploadDate?.match(/^[0-9]{8}$/)) {
    return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
  }

  const timestamp =
    numberValue(metadata?.timestamp) ??
    numberValue(metadata?.release_timestamp);
  if (timestamp !== undefined) {
    return new Date(timestamp * 1000).toISOString().slice(0, 10);
  }

  const sourceCreatedAt = stringValue(metadata?.sourceCreatedAt);
  if (sourceCreatedAt?.match(/^[0-9]{4}-[0-9]{2}-[0-9]{2}/)) {
    return sourceCreatedAt.slice(0, 10);
  }

  return undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function decodeHtmlEntities(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replaceAll(
    /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|#39);/gi,
    (entity, code: string) => {
      const lower = code.toLowerCase();
      if (lower === "amp") return "&";
      if (lower === "lt") return "<";
      if (lower === "gt") return ">";
      if (lower === "quot") return '"';
      if (lower === "apos" || lower === "#39") return "'";
      const point = lower.startsWith("#x")
        ? Number.parseInt(lower.slice(2), 16)
        : Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : entity;
    },
  );
}

function escapeXmlText(value: string): string {
  return replaceLoneSurrogates(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
