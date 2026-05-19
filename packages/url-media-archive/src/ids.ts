const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref",
]);

export function canonicalizeUrl(input: string): string {
  const url = new URL(input);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";

  if (isDefaultPort(url.protocol, url.port)) {
    url.port = "";
  }

  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMS.has(key)) {
      url.searchParams.delete(key);
    }
  }

  url.searchParams.sort();

  return url.toString();
}

export function jobKeyForJobId(jobId: string): string {
  return `pg:${jobId}`;
}

export function jobIdFromJobKey(jobKey: string): string | null {
  const match =
    /^pg:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.exec(
      jobKey,
    );
  return match?.[1]?.toLowerCase() ?? null;
}

function isDefaultPort(protocol: string, port: string): boolean {
  return (
    (protocol === "https:" && port === "443") ||
    (protocol === "http:" && port === "80")
  );
}
