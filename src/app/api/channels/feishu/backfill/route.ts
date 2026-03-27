import { NextResponse } from "next/server";
import { ensureChannelRuntimeStarted } from "@/lib/server/channel-runtime";
import { backfillFeishuRoomNicknames } from "@/lib/server/channels/feishu/backfill";

export const runtime = "nodejs";

export async function POST() {
  ensureChannelRuntimeStarted();

  try {
    const result = await backfillFeishuRoomNicknames();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to backfill Feishu nicknames." },
      { status: 500 },
    );
  }
}
