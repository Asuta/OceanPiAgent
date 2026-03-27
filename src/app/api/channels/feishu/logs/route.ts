import { NextResponse } from "next/server";
import { ensureChannelRuntimeStarted, getChannelRuntimeStatus } from "@/lib/server/channel-runtime";

export const runtime = "nodejs";

export async function GET(request: Request) {
  ensureChannelRuntimeStarted();
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit")?.trim() || "100";
  const limit = Math.max(1, Math.min(200, Number.parseInt(rawLimit, 10) || 100));
  const status = getChannelRuntimeStatus().feishu;
  return NextResponse.json({
    logFilePath: status.logFilePath,
    logs: status.recentLogs.slice(Math.max(0, status.recentLogs.length - limit)),
  });
}
