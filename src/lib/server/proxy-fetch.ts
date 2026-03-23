import { ProxyAgent, type Dispatcher } from "undici";

type FetchOptions = RequestInit & {
  dispatcher?: Dispatcher;
};

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

const NO_PROXY_ENV_KEYS = ["NO_PROXY", "no_proxy"] as const;

const dispatcherCache = new Map<string, Dispatcher>();

function readProxyUrl(): string | undefined {
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function readNoProxyRules(): string[] {
  for (const key of NO_PROXY_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) {
      return value
        .split(",")
        .map((rule) => rule.trim().toLowerCase())
        .filter(Boolean);
    }
  }

  return [];
}

function hostnameMatchesRule(hostname: string, rule: string): boolean {
  if (rule === "*") {
    return true;
  }

  const normalizedHostname = hostname.toLowerCase();
  const normalizedRule = rule.startsWith(".") ? rule.slice(1) : rule;

  return (
    normalizedHostname === normalizedRule ||
    normalizedHostname.endsWith(`.${normalizedRule}`)
  );
}

function shouldBypassProxy(url: URL): boolean {
  const rules = readNoProxyRules();
  if (rules.length === 0) {
    return false;
  }

  return rules.some((rule) => hostnameMatchesRule(url.hostname, rule));
}

function getProxyDispatcher(proxyUrl: string): Dispatcher {
  const cached = dispatcherCache.get(proxyUrl);
  if (cached) {
    return cached;
  }

  const dispatcher = new ProxyAgent(proxyUrl);
  dispatcherCache.set(proxyUrl, dispatcher);
  return dispatcher;
}

export async function proxyAwareFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof URL ? input : new URL(input);
  const proxyUrl = readProxyUrl();

  const requestInit: FetchOptions = { ...init };
  if (proxyUrl && !shouldBypassProxy(url)) {
    requestInit.dispatcher = getProxyDispatcher(proxyUrl);
  }

  try {
    return await fetch(url, requestInit);
  } catch (error) {
    const causeMessage =
      error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
    const message = causeMessage
      ? `Network request failed for ${url.origin}: ${causeMessage}`
      : error instanceof Error
        ? error.message
        : "Unknown network error.";

    throw new Error(message, {
      cause: error,
    });
  }
}
