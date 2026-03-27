import { NextResponse } from "next/server";
import { ensureChannelRuntimeStarted, getChannelRuntimeStatus } from "@/lib/server/channel-runtime";

export const runtime = "nodejs";

export async function GET() {
  ensureChannelRuntimeStarted();
  return NextResponse.json(getChannelRuntimeStatus().feishu);
}
