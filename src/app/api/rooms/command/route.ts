import { NextResponse } from "next/server";
import { z } from "zod";
import { messageImageAttachmentSchema } from "@/lib/chat/schemas";
import { ensureChannelRuntimeStarted } from "@/lib/server/channel-runtime";
import { ensureCronDispatcherStarted } from "@/lib/server/cron-dispatcher";
import { runRoomCommand } from "@/lib/server/room-service";

export const runtime = "nodejs";

const baseSchema = z.object({
  type: z.string().trim().min(1),
});

const createRoomSchema = baseSchema.extend({
  type: z.literal("create_room"),
  agentId: z.string().trim().min(1).max(120).optional(),
});

const commandSchema = z.discriminatedUnion("type", [
  createRoomSchema,
  baseSchema.extend({ type: z.literal("rename_room"), roomId: z.string().trim().min(1).max(120), title: z.string().trim().min(1).max(120) }),
  baseSchema.extend({ type: z.literal("archive_room"), roomId: z.string().trim().min(1).max(120) }),
  baseSchema.extend({ type: z.literal("restore_room"), roomId: z.string().trim().min(1).max(120) }),
  baseSchema.extend({ type: z.literal("delete_room"), roomId: z.string().trim().min(1).max(120) }),
  baseSchema.extend({ type: z.literal("clear_room"), roomId: z.string().trim().min(1).max(120) }),
  baseSchema.extend({ type: z.literal("stop_room"), roomId: z.string().trim().min(1).max(120) }),
  baseSchema.extend({ type: z.literal("add_human_participant"), roomId: z.string().trim().min(1).max(120), name: z.string().trim().min(1).max(120) }),
  baseSchema.extend({ type: z.literal("add_agent_participant"), roomId: z.string().trim().min(1).max(120), agentId: z.string().trim().min(1).max(120) }),
  baseSchema.extend({ type: z.literal("remove_participant"), roomId: z.string().trim().min(1).max(120), participantId: z.string().trim().min(1).max(120) }),
  baseSchema.extend({ type: z.literal("toggle_agent_participant"), roomId: z.string().trim().min(1).max(120), participantId: z.string().trim().min(1).max(120) }),
  baseSchema.extend({ type: z.literal("move_agent_participant"), roomId: z.string().trim().min(1).max(120), participantId: z.string().trim().min(1).max(120), direction: z.union([z.literal(-1), z.literal(1)]) }),
  baseSchema.extend({
    type: z.literal("send_message"),
    roomId: z.string().trim().min(1).max(120),
    content: z.string().max(20_000),
    attachments: z.array(messageImageAttachmentSchema).max(3).optional().default([]),
    senderId: z.string().trim().min(1).max(120).optional(),
  }),
]);

export async function POST(request: Request) {
  try {
    ensureCronDispatcherStarted();
    ensureChannelRuntimeStarted();
    const payload = commandSchema.parse(await request.json());
    const result = await runRoomCommand(payload);
    return NextResponse.json({
      ok: true,
      envelope: result.envelope,
      roomId: result.room?.id ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
