export interface FeishuChannelConfig {
  enabled: boolean;
  configured: boolean;
  accountId: string;
  appId: string;
  appSecret: string;
  defaultAgentId: string;
  allowOpenIds: string[];
  ackReactionEmojiType: string;
  doneReactionEmojiType: string;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
}

export function readFeishuChannelConfig(): FeishuChannelConfig {
  const appId = process.env.FEISHU_APP_ID?.trim() || "";
  const appSecret = process.env.FEISHU_APP_SECRET?.trim() || "";
  const configured = Boolean(appId && appSecret);
  const requestedEnabled = isTruthyEnv(process.env.FEISHU_ENABLED);

  return {
    enabled: requestedEnabled && configured,
    configured,
    accountId: process.env.FEISHU_ACCOUNT_ID?.trim() || "default",
    appId,
    appSecret,
    defaultAgentId: process.env.FEISHU_DEFAULT_AGENT_ID?.trim() || "concierge",
    allowOpenIds: parseList(process.env.FEISHU_ALLOW_OPEN_IDS),
    ackReactionEmojiType: process.env.FEISHU_REACTION_ACK?.trim() || "OK",
    doneReactionEmojiType: process.env.FEISHU_REACTION_DONE?.trim() || "DONE",
  };
}
