import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultWorkspaceState, createRoomMessage } from "@/lib/chat/workspace-domain";
import type { RoomCronJob, RoomCronRunRecord } from "@/lib/chat/types";
import { runQueuedCronJobForTest } from "@/lib/server/cron-dispatcher";

test("runQueuedCronJobForTest resolves model config overrides before non-streaming execution", async () => {
  let state = createDefaultWorkspaceState();
  const room = state.rooms[0]!;
  const scheduledFor = "2026-04-05T05:00:00.000Z";
  const job: RoomCronJob = {
    id: "job-1",
    agentId: "concierge",
    targetRoomId: room.id,
    title: "Cron deepseek job",
    prompt: "Use the configured model endpoint.",
    schedule: {
      type: "once",
      at: scheduledFor,
    },
    deliveryPolicy: "always_post_summary",
    enabled: true,
    status: "idle",
    lastRunAt: null,
    nextRunAt: scheduledFor,
    lastError: null,
    createdAt: scheduledFor,
    updatedAt: scheduledFor,
  };
  let cronStore: {
    jobs: RoomCronJob[];
    runs: RoomCronRunRecord[];
  } = {
    jobs: [job],
    runs: [],
  };

  let forwardedSettingsModel = "";
  let forwardedBaseUrl = "";
  let forwardedApiKey = "";

  await runQueuedCronJobForTest(
    {
      jobId: job.id,
      scheduledFor,
      force: true,
    },
    {
      loadCronStore: async () => cronStore,
      mutateCronStore: async (mutator) => {
        cronStore = await mutator(cronStore);
        return cronStore;
      },
      loadWorkspaceEnvelope: async () => ({
        version: 1,
        updatedAt: scheduledFor,
        state,
      }),
      resolveSettingsWithModelConfig: async (settings) => ({
        settings: {
          ...settings,
          model: "deepseek-chat",
        },
        modelConfig: null,
        modelConfigOverrides: {
          baseUrl: "https://api.deepseek.com",
          apiKey: "deepseek-key",
        },
      }),
      runRoomTurnNonStreaming: async ({ roomId, agentId, settings, modelConfigOverrides }) => {
        forwardedSettingsModel = settings.model;
        forwardedBaseUrl = modelConfigOverrides?.baseUrl ?? "";
        forwardedApiKey = modelConfigOverrides?.apiKey ?? "";

        const emittedMessages = [
          createRoomMessage(roomId, "assistant", "Cron summary", "agent_emit", {
            sender: {
              id: agentId,
              name: "Harbor Concierge",
              role: "participant",
            },
          }),
        ];

        return {
          turn: {
            id: `turn-${agentId}`,
            agent: {
              id: agentId,
              label: agentId,
            },
            userMessage: createRoomMessage(roomId, "system", "[Scheduled room task]", "system", {
              sender: {
                id: `cron-${job.id}`,
                name: "Scheduled Task",
                role: "system",
              },
              kind: "system",
            }),
            assistantContent: "done",
            tools: [],
            emittedMessages,
            status: "completed",
            resolvedModel: "deepseek-chat",
          },
          resolvedModel: "deepseek-chat",
          compatibility: {
            providerKey: "generic",
            providerLabel: "Generic",
            baseUrl: "https://api.deepseek.com",
            chatCompletionsToolStyle: "tools",
            responsesContinuation: "replay",
            responsesPayloadMode: "json",
            notes: [],
          },
          emittedMessages,
          receiptUpdates: [],
          roomActions: [],
        };
      },
      mutateWorkspace: async (mutator) => {
        state = await mutator(state);
        return {
          version: 2,
          updatedAt: scheduledFor,
          state,
        };
      },
    },
  );

  assert.equal(forwardedSettingsModel, "deepseek-chat");
  assert.equal(forwardedBaseUrl, "https://api.deepseek.com");
  assert.equal(forwardedApiKey, "deepseek-key");
  assert.equal(cronStore.jobs[0]?.status, "idle");
  assert.equal(cronStore.runs[0]?.status, "completed");
});
