import { buildPreparedInputFromWorkspace, runPreparedRoomTurn } from "@/lib/server/room-runner";
import { resolveSettingsWithModelConfig } from "@/lib/server/model-config-store";
import { getRoomTurnTailLogFilePath } from "@/lib/server/room-turn-tail-log";
import { loadWorkspaceEnvelope } from "@/lib/server/workspace-store";

async function main() {
  const roomId = process.argv[2]?.trim();
  const agentId = process.argv[3]?.trim();
  const content = process.argv.slice(4).join(" ").trim() || "这是一条性能测试消息。请直接给出一段较长的中文回复，不要调用外部搜索工具。";

  if (!roomId || !agentId) {
    throw new Error("Usage: npx tsx scripts/profile-room-turn-tail.ts <roomId> <agentId> <message>");
  }

  const workspaceEnvelope = await loadWorkspaceEnvelope();
  const persistedSettings = workspaceEnvelope.state.agentStates[agentId]?.settings;
  if (!persistedSettings) {
    throw new Error(`Agent ${agentId} does not have persisted workspace settings.`);
  }

  const resolvedSelection = await resolveSettingsWithModelConfig(persistedSettings);
  const preparedInput = await buildPreparedInputFromWorkspace({
    workspace: workspaceEnvelope.state,
    roomId,
    agentId,
    message: {
      id: `tail-profile-${Date.now()}`,
      content,
      attachments: [],
      sender: {
        id: "local-user",
        name: "You",
        role: "participant",
      },
    },
    settings: resolvedSelection.settings,
  });
  preparedInput.modelConfigOverrides = resolvedSelection.modelConfigOverrides;

  const startedAt = performance.now();
  const result = await runPreparedRoomTurn(preparedInput);
  const elapsedMs = Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);

  console.log(JSON.stringify({
    elapsedMs,
    turnStatus: result.turn.status,
    resolvedModel: result.resolvedModel,
    emittedMessages: result.emittedMessages.length,
    roomId,
    agentId,
    logFile: getRoomTurnTailLogFilePath(),
  }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
