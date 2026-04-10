const OPENAI_FETCH_COMPAT_HOSTS = new Set(["lucen.cc"]);

const DEFAULT_APP_REFERER = process.env.APP_URL?.trim() || "http://localhost:3000";
const DEFAULT_APP_TITLE = "Quiet Wizard";

let installed = false;
let baseFetch: typeof fetch | null = null;

function normalizeHostname(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  }
  catch {
    return null;
  }
}

function getRequestUrl(input: RequestInfo | URL): string | null {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return null;
}

export function shouldUseOpenAiFetchCompatibility(baseUrl: string): boolean {
  const hostname = normalizeHostname(baseUrl);
  return hostname !== null && OPENAI_FETCH_COMPAT_HOSTS.has(hostname);
}

export function buildOpenAiFetchCompatibilityHeaders(source?: HeadersInit): Headers {
  const headers = new Headers(source);

  for (const name of [...headers.keys()]) {
    const normalized = name.toLowerCase();
    if (normalized === "user-agent" || normalized.startsWith("x-stainless")) {
      headers.delete(name);
    }
  }

  const authorization = headers.get("authorization")?.trim();
  if (authorization?.toLowerCase().startsWith("bearer ") && !headers.has("x-api-key")) {
    headers.set("X-Api-Key", authorization.slice(7).trim());
  }

  if (!headers.has("http-referer")) {
    headers.set("HTTP-Referer", DEFAULT_APP_REFERER);
  }

  if (!headers.has("x-title")) {
    headers.set("X-Title", DEFAULT_APP_TITLE);
  }

  return headers;
}

export function ensureOpenAiFetchCompatibility(baseUrl: string): void {
  if (!shouldUseOpenAiFetchCompatibility(baseUrl) || installed) {
    return;
  }

  baseFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl = getRequestUrl(input);
    if (!requestUrl || !shouldUseOpenAiFetchCompatibility(requestUrl)) {
      return baseFetch!(input, init);
    }

    const requestHeaders = typeof Request !== "undefined" && input instanceof Request
      ? input.headers
      : undefined;
    const headers = buildOpenAiFetchCompatibilityHeaders(init?.headers ?? requestHeaders);
    return baseFetch!(input, { ...init, headers });
  }) as typeof fetch;
  installed = true;
}
