import { isIP } from "net";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export function assertSafeArchiveUrl(input: string): void {
  const url = new URL(input);
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new Error(`unsupported URL scheme: ${url.protocol}`);
  }

  const hostname = stripIpv6Brackets(url.hostname.toLowerCase());
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error(`private or local URL target rejected: ${url.hostname}`);
  }

  if (isPrivateOrLocalIpLiteral(hostname)) {
    throw new Error(`private or local URL target rejected: ${url.hostname}`);
  }
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isPrivateOrLocalIpLiteral(hostname: string): boolean {
  const version = isIP(hostname);
  if (version === 0) return false;
  if (version === 4) return isPrivateOrLocalIpv4(hostname);
  return isPrivateOrLocalIpv6(hostname);
}

function isPrivateOrLocalIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map((part) => Number(part));
  const [first, second] = octets;
  if (first === undefined || second === undefined) return true;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function isPrivateOrLocalIpv6(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fe80:") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd")
  );
}
