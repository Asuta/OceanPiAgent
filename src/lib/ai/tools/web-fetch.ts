import { lookup } from "node:dns/promises";
import net from "node:net";
import * as cheerio from "cheerio";
import { truncateText } from "@/lib/shared/text";
import { proxyAwareFetch } from "@/lib/server/proxy-fetch";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CHARS = 12_000;

interface WebFetchArgs {
  url: string;
  focus?: string;
}

function createRequestSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
  if (!signal) {
    return timeoutSignal;
  }

  return AbortSignal.any([signal, timeoutSignal]);
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((value) => Number.isNaN(value))) {
    return false;
  }

  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    first === 0 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80")
  );
}

async function assertPublicHostname(hostname: string): Promise<void> {
  const lowerHostname = hostname.toLowerCase();
  if (
    lowerHostname === "localhost" ||
    lowerHostname.endsWith(".localhost") ||
    lowerHostname.endsWith(".local")
  ) {
    throw new Error("Local or private hostnames are blocked.");
  }

  const records = await lookup(hostname, { all: true });
  for (const record of records) {
    if (
      (record.family === 4 && isPrivateIpv4(record.address)) ||
      (record.family === 6 && isPrivateIpv6(record.address))
    ) {
      throw new Error("Private network addresses are blocked.");
    }
  }
}

function extractReadableText(html: string): { title: string; content: string } {
  const $ = cheerio.load(html);
  $("script, style, noscript, iframe, svg").remove();

  const title = $("title").first().text().trim() || "Untitled";
  const content = $("body").text().replace(/\s+/g, " ").trim();

  return {
    title,
    content,
  };
}

export async function fetchWebPage({ url, focus }: WebFetchArgs, signal?: AbortSignal): Promise<string> {
  const parsedUrl = new URL(url);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Only http and https URLs are allowed.");
  }

  if (net.isIP(parsedUrl.hostname)) {
    const blocked =
      (net.isIPv4(parsedUrl.hostname) && isPrivateIpv4(parsedUrl.hostname)) ||
      (net.isIPv6(parsedUrl.hostname) && isPrivateIpv6(parsedUrl.hostname));

    if (blocked) {
      throw new Error("Private IP ranges are blocked.");
    }
  } else {
    await assertPublicHostname(parsedUrl.hostname);
  }

  const response = await proxyAwareFetch(parsedUrl, {
    signal: createRequestSignal(signal),
    headers: {
      "User-Agent": "OceanKing/0.1 (+https://github.com/Asuta/OceanKing)",
      Accept: "text/html, text/plain, application/xhtml+xml, application/json;q=0.9, */*;q=0.1",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const rawText = await response.text();

  let title = parsedUrl.hostname;
  let content = rawText;

  if (contentType.includes("html") || rawText.includes("<html")) {
    const extracted = extractReadableText(rawText);
    title = extracted.title;
    content = extracted.content;
  } else {
    content = rawText.replace(/\s+/g, " ").trim();
  }

  const focusLine = focus?.trim() ? `Focus hint: ${focus.trim()}\n` : "";

  return [
    `URL: ${response.url}`,
    `Title: ${title}`,
    focusLine,
    "Content:",
    truncateText(content || "No readable text found.", DEFAULT_MAX_CHARS),
  ]
    .filter(Boolean)
    .join("\n");
}
