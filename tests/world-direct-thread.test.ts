import assert from "node:assert/strict";
import test from "node:test";
import { buildWorldDirectThreadTimeline } from "@/components/room/world-direct-thread";
import type { AgentRoomTurn, RoomMessage, ToolExecution, TurnTimelineEvent } from "@/lib/chat/types";
import type { RoomThreadDraftEntry, RoomThreadToolEntry } from "@/components/workspace/room-thread";

function createMessage(overrides?: Partial<RoomMessage>): RoomMessage {
  return {
    id: "message-1",
    roomId: "room-1",
    seq: 1,
    role: "assistant",
    sender: {
      id: "concierge",
      name: "Harbor Concierge",
      role: "participant",
    },
    content: "Visible reply",
    attachments: [],
    source: "agent_emit",
    kind: "answer",
    status: "completed",
    final: true,
    createdAt: "2026-04-19T10:00:00.000Z",
    receipts: [],
    receiptStatus: "none",
    receiptUpdatedAt: null,
    ...overrides,
  };
}

function createTool(id: string, sequence: number): ToolExecution {
  return {
    id,
    sequence,
    toolName: "web_search",
    displayName: `Tool ${id}`,
    inputSummary: "search",
    inputText: "query",
    resultPreview: "done",
    outputText: "done",
    status: "success",
    durationMs: 100,
  };
}

function createTurn(overrides?: Partial<AgentRoomTurn>): AgentRoomTurn {
  return {
    id: "turn-1",
    agent: {
      id: "concierge",
      label: "Harbor Concierge",
    },
    userMessage: createMessage({
      id: "user-1",
      role: "user",
      source: "user",
      kind: "user_input",
      sender: {
        id: "local-operator",
        name: "You",
        role: "participant",
      },
      content: "你好",
      createdAt: "2026-04-19T09:59:00.000Z",
    }),
    assistantContent: "我来查一下",
    emittedMessages: [],
    tools: [],
    status: "completed",
    timeline: [] satisfies TurnTimelineEvent[],
    ...overrides,
  };
}

function createToolEntry(anchorMessageId: string, toolId: string, sequence: number): RoomThreadToolEntry {
  const turn = createTurn({
    id: `turn-${toolId}`,
    tools: [createTool(toolId, sequence)],
    timeline: [{ id: `tool:${toolId}`, type: "tool", toolId, sequence }],
  });

  return {
    id: `${turn.id}:${toolId}`,
    turn,
    tool: turn.tools[0]!,
    anchorMessageId,
    event: turn.timeline[0] as Extract<TurnTimelineEvent, { type: "tool" }>,
    isLatestForAnchor: true,
  };
}

function createDraftEntry(anchorMessageId: string, segmentId: string, sequence: number): RoomThreadDraftEntry {
  const turn = createTurn({
    id: `turn-${segmentId}`,
    draftSegments: [
      {
        id: segmentId,
        sequence,
        content: "草稿片段",
        status: "completed",
      },
    ],
    timeline: [{ id: `draft:${segmentId}`, type: "draft-segment", segmentId, sequence }],
  });

  return {
    id: `${turn.id}:${segmentId}`,
    turn,
    anchorMessageId,
    segment: turn.draftSegments![0]!,
    event: turn.timeline[0] as Extract<TurnTimelineEvent, { type: "draft-segment" }>,
  };
}

test("buildWorldDirectThreadTimeline keeps messages in thread order and mixes anchored artifacts by sequence", () => {
  const userMessage = createMessage({
    id: "user-1",
    seq: 1,
    role: "user",
    source: "user",
    kind: "user_input",
    sender: {
      id: "local-operator",
      name: "You",
      role: "participant",
    },
    content: "先搜一下",
    createdAt: "2026-04-19T09:59:00.000Z",
  });
  const answerMessage = createMessage({
    id: "answer-1",
    seq: 2,
    content: "我去查",
    createdAt: "2026-04-19T10:00:00.000Z",
  });

  const timeline = buildWorldDirectThreadTimeline({
    roomMessages: [answerMessage, userMessage],
    toolEntriesByAnchor: new Map([
      [
        "user-1",
        [createToolEntry("user-1", "tool-2", 2), createToolEntry("user-1", "tool-1", 1)],
      ],
    ]),
    draftEntriesByAnchor: new Map([
      [
        "answer-1",
        [createDraftEntry("answer-1", "draft-1", 3)],
      ],
    ]),
  });

  assert.deepEqual(
    timeline.map((entry) => `${entry.kind}:${entry.id}`),
    ["message:user-1", "tool:turn-tool-1:tool-1", "tool:turn-tool-2:tool-2", "message:answer-1", "draft:turn-draft-1:draft-1"],
  );
});

