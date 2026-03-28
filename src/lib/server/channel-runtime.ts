import { receiveExternalMessage } from "@/lib/server/channel-message-service";
import { readFeishuChannelConfig } from "@/lib/server/channel-config";
import { startFeishuChannelRuntime } from "@/lib/server/channels/feishu";
import { resolveFeishuDisplayNameFromOpenId } from "@/lib/server/channels/feishu/client";
import { deliverFeishuMessages } from "@/lib/server/channels/feishu/outbound";
import { appendFeishuRuntimeLog, getFeishuRuntimeLogFilePath, listFeishuRuntimeLogs, type FeishuRuntimeLogEntry } from "@/lib/server/channel-runtime-log";

type FeishuRuntimeStatus = {
  enabled: boolean;
  configured: boolean;
  status: "disabled" | "idle" | "starting" | "running" | "error";
  accountId: string;
  defaultAgentId: string;
  allowOpenIds: string[];
  ackReactionEmojiType: string;
  doneReactionEmojiType: string;
  lastError: string | null;
  startedAt: string | null;
  lastInboundAt: string | null;
  logFilePath: string;
  recentLogs: FeishuRuntimeLogEntry[];
};

const CHANNEL_RUNTIME_VERSION = 1;

declare global {
  var __oceankingChannelRuntimeStarted: boolean | undefined;
  var __oceankingChannelRuntimeVersion: number | undefined;
  var __oceankingChannelRuntimeAbortController: AbortController | undefined;
  var __oceankingFeishuRuntimeStatus: FeishuRuntimeStatus | undefined;
}

function createStatus(): FeishuRuntimeStatus {
  const config = readFeishuChannelConfig();
  return {
    enabled: config.enabled,
    configured: config.configured,
    status: config.enabled ? "idle" : "disabled",
    accountId: config.accountId,
    defaultAgentId: config.defaultAgentId,
    allowOpenIds: [...config.allowOpenIds],
    ackReactionEmojiType: config.ackReactionEmojiType,
    doneReactionEmojiType: config.doneReactionEmojiType,
    lastError: null,
    startedAt: null,
    lastInboundAt: null,
    logFilePath: getFeishuRuntimeLogFilePath(),
    recentLogs: listFeishuRuntimeLogs(),
  };
}

function syncStatusLogs(status: FeishuRuntimeStatus): void {
  status.logFilePath = getFeishuRuntimeLogFilePath();
  status.recentLogs = listFeishuRuntimeLogs();
}

function getMutableStatus(): FeishuRuntimeStatus {
  if (!globalThis.__oceankingFeishuRuntimeStatus) {
    globalThis.__oceankingFeishuRuntimeStatus = createStatus();
  }
  syncStatusLogs(globalThis.__oceankingFeishuRuntimeStatus);
  return globalThis.__oceankingFeishuRuntimeStatus;
}

export function getChannelRuntimeStatus() {
  return {
    feishu: { ...getMutableStatus() },
  };
}

export function ensureChannelRuntimeStarted(): void {
  const config = readFeishuChannelConfig();
  const status = getMutableStatus();
  status.enabled = config.enabled;
  status.configured = config.configured;
  status.accountId = config.accountId;
  status.defaultAgentId = config.defaultAgentId;
  status.allowOpenIds = [...config.allowOpenIds];
  status.ackReactionEmojiType = config.ackReactionEmojiType;
  status.doneReactionEmojiType = config.doneReactionEmojiType;

  if (!config.enabled) {
    status.status = config.configured ? "idle" : "disabled";
    appendFeishuRuntimeLog({
      level: "info",
      message: config.configured ? "Feishu runtime is configured but disabled" : "Feishu runtime is not configured",
    });
    syncStatusLogs(status);
    return;
  }

  if (globalThis.__oceankingChannelRuntimeStarted && globalThis.__oceankingChannelRuntimeVersion === CHANNEL_RUNTIME_VERSION) {
    return;
  }

  globalThis.__oceankingChannelRuntimeStarted = true;
  globalThis.__oceankingChannelRuntimeVersion = CHANNEL_RUNTIME_VERSION;
  globalThis.__oceankingChannelRuntimeAbortController?.abort();

  const controller = new AbortController();
  globalThis.__oceankingChannelRuntimeAbortController = controller;

  status.status = "starting";
  status.lastError = null;
  appendFeishuRuntimeLog({
    level: "info",
    message: "Initializing Feishu runtime",
    details: {
      accountId: config.accountId,
      defaultAgentId: config.defaultAgentId,
      allowlistEnabled: config.allowOpenIds.length > 0,
    },
  });
  syncStatusLogs(status);

  void startFeishuChannelRuntime(controller.signal, {
    onStarted: () => {
      const currentStatus = getMutableStatus();
      currentStatus.status = "running";
      currentStatus.startedAt = new Date().toISOString();
      currentStatus.lastError = null;
      appendFeishuRuntimeLog({
        level: "info",
        message: "Feishu runtime started",
        details: {
          accountId: currentStatus.accountId,
        },
      });
      syncStatusLogs(currentStatus);
    },
    onError: (error) => {
      const currentStatus = getMutableStatus();
      currentStatus.status = "error";
      currentStatus.lastError = error instanceof Error ? error.message : "Unknown Feishu runtime error.";
      appendFeishuRuntimeLog({
        level: "error",
        message: "Feishu runtime reported an error",
        details: {
          error: currentStatus.lastError,
        },
      });
      syncStatusLogs(currentStatus);
    },
    onLog: appendFeishuRuntimeLog,
    onInboundMessage: async (message) => {
      const currentStatus = getMutableStatus();
      currentStatus.lastInboundAt = new Date().toISOString();
      currentStatus.status = "running";
      appendFeishuRuntimeLog({
        level: "info",
        message: "Received Feishu inbound message",
        details: {
          peerId: message.peerId,
          messageId: message.messageId,
          messageType: message.messageType,
          attachmentCount: message.attachments.length,
        },
      });
      const feishuConfig = readFeishuChannelConfig();
      try {
        let enrichedMessage = message;
        try {
          const resolvedSenderName = await resolveFeishuDisplayNameFromOpenId(feishuConfig, message.senderId);
          if (resolvedSenderName && resolvedSenderName !== message.senderName) {
            enrichedMessage = {
              ...message,
              senderName: resolvedSenderName,
            };
            appendFeishuRuntimeLog({
              level: "info",
              message: "Resolved Feishu sender display name",
              details: {
                peerId: message.peerId,
                senderName: resolvedSenderName,
              },
            });
          }
        } catch (error) {
          appendFeishuRuntimeLog({
            level: "warn",
            message: "Failed to resolve Feishu sender display name",
            details: {
              peerId: message.peerId,
              error: error instanceof Error ? error.message : "Unknown display-name lookup error.",
            },
          });
        }

        await receiveExternalMessage(enrichedMessage, {
          deliverMessages: async (messages) => {
            appendFeishuRuntimeLog({
              level: "info",
              message: "Delivering Feishu outbound messages",
              details: {
                peerId: enrichedMessage.peerId,
                messageType: enrichedMessage.messageType,
                count: messages.length,
              },
            });
            await deliverFeishuMessages(messages, feishuConfig);
          },
          logger: appendFeishuRuntimeLog,
        });
      } catch (error) {
        currentStatus.status = "error";
        currentStatus.lastError = error instanceof Error ? error.message : "Unknown Feishu inbound error.";
        appendFeishuRuntimeLog({
          level: "error",
          message: "Failed while handling Feishu inbound message",
          details: {
            peerId: message.peerId,
            messageId: message.messageId,
            messageType: message.messageType,
            error: currentStatus.lastError,
          },
        });
      } finally {
        syncStatusLogs(currentStatus);
      }
    },
  }).catch((error) => {
    const currentStatus = getMutableStatus();
    currentStatus.status = "error";
    currentStatus.lastError = error instanceof Error ? error.message : "Unknown Feishu runtime error.";
    appendFeishuRuntimeLog({
      level: "error",
      message: "Feishu runtime crashed",
      details: {
        error: currentStatus.lastError,
      },
    });
    syncStatusLogs(currentStatus);
  });
}
