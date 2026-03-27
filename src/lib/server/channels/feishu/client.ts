import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuChannelConfig } from "@/lib/server/channels/feishu/config";

const clientCache = new Map<string, Lark.Client>();

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
