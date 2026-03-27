import { mutateWorkspace } from "@/lib/server/workspace-store";
import { loadChannelBindings } from "@/lib/server/channel-bindings-store";
import { readFeishuChannelConfig } from "@/lib/server/channel-config";
import { appendFeishuRuntimeLog } from "@/lib/server/channel-runtime-log";
import { resolveFeishuDisplayNameFromOpenId } from "@/lib/server/channels/feishu/client";
import { applyFeishuRoomMetadata } from "@/lib/server/channels/feishu/room-metadata";
import type { ChannelBinding } from "@/lib/server/channels/types";
import type { RoomWorkspaceState } from "@/lib/chat/types";

export interface FeishuNicknameBackfillResult {
  scanned: number;
  updated: number;
  skipped: number;
}

export interface FeishuNicknameBackfillDependencies {
  readConfig?: typeof readFeishuChannelConfig;
  loadBindings?: typeof loadChannelBindings;
  resolveDisplayName?: typeof resolveFeishuDisplayNameFromOpenId;
  mutateWorkspace?: typeof mutateWorkspace;
  logger?: typeof appendFeishuRuntimeLog;
}

export async function backfillFeishuRoomNicknames(overrides: FeishuNicknameBackfillDependencies = {}): Promise<FeishuNicknameBackfillResult> {
  const readConfig = overrides.readConfig ?? readFeishuChannelConfig;
  const loadBindings = overrides.loadBindings ?? loadChannelBindings;
  const resolveDisplayName = overrides.resolveDisplayName ?? resolveFeishuDisplayNameFromOpenId;
  const mutateWorkspaceState = overrides.mutateWorkspace ?? mutateWorkspace;
  const logger = overrides.logger ?? appendFeishuRuntimeLog;

  const config = readConfig();
  if (!config.configured) {
    throw new Error("Feishu is not configured.");
  }

  const bindings = (await loadBindings()).filter((binding) => binding.channel === "feishu" && binding.peerKind === "direct");
  let updated = 0;
  let skipped = 0;

  const resolvedNames = new Map<string, string>();
  for (const binding of bindings) {
    try {
      const resolvedName = await resolveDisplayName(config, binding.peerId);
      if (resolvedName) {
        resolvedNames.set(binding.roomId, resolvedName);
      } else {
        skipped += 1;
      }
    } catch (error) {
      skipped += 1;
      logger({
        level: "warn",
        message: "Failed to backfill Feishu nickname for room",
        details: {
          roomId: binding.roomId,
          peerId: binding.peerId,
          error: error instanceof Error ? error.message : "Unknown backfill lookup error.",
        },
      });
    }
  }

  if (resolvedNames.size > 0) {
    await mutateWorkspaceState((workspace: RoomWorkspaceState) => ({
      ...workspace,
      rooms: workspace.rooms.map((room) => {
        const binding = bindings.find((entry: ChannelBinding) => entry.roomId === room.id);
        const resolvedName = resolvedNames.get(room.id);
        if (!binding || !resolvedName) {
          return room;
        }
        const nextRoom = applyFeishuRoomMetadata(room, binding, resolvedName);
        if (nextRoom.title === room.title && nextRoom.participants.every((participant, index) => participant.name === room.participants[index]?.name)) {
          return room;
        }
        updated += 1;
        return nextRoom;
      }),
    }));
  }

  logger({
    level: "info",
    message: "Completed Feishu nickname backfill",
    details: {
      scanned: bindings.length,
      updated,
      skipped,
    },
  });

  return {
    scanned: bindings.length,
    updated,
    skipped,
  };
}
