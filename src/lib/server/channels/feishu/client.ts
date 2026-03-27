import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuChannelConfig } from "@/lib/server/channels/feishu/config";

const clientCache = new Map<string, Lark.Client>();
const displayNameCache = new Map<string, { value: string | null; expiresAt: number }>();
const DISPLAY_NAME_CACHE_TTL_MS = 10 * 60 * 1000;

export function getFeishuRestClient(config: FeishuChannelConfig): Lark.Client {
  const cacheKey = `${config.accountId}:${config.appId}`;
  const cached = clientCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const client = new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
  });
  clientCache.set(cacheKey, client);
  return client;
}

export function createFeishuEventDispatcher(): Lark.EventDispatcher {
  return new Lark.EventDispatcher({});
}

export function createFeishuWsClient(config: FeishuChannelConfig): Lark.WSClient {
  return new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: Lark.Domain.Feishu,
    loggerLevel: Lark.LoggerLevel.info,
  });
}

export async function resolveFeishuDisplayNameFromOpenId(config: FeishuChannelConfig, openId: string): Promise<string | null> {
  const normalizedOpenId = openId.trim();
  if (!normalizedOpenId) {
    return null;
  }

  const cacheKey = `${config.accountId}:${normalizedOpenId}`;
  const cached = displayNameCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const client = getFeishuRestClient(config);
  const response = await client.contact.user.get({
    params: {
      user_id_type: "open_id",
    },
    path: {
      user_id: normalizedOpenId,
    },
  });

  if (typeof response.code === "number" && response.code !== 0) {
    throw new Error(response.msg || `Failed to resolve Feishu user ${normalizedOpenId}.`);
  }

  const user = response.data?.user;
  const resolvedName = user?.nickname?.trim() || user?.name?.trim() || null;
  displayNameCache.set(cacheKey, {
    value: resolvedName,
    expiresAt: now + DISPLAY_NAME_CACHE_TTL_MS,
  });
  return resolvedName;
}
