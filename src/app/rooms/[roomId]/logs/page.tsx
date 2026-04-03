import { RoomLogPage } from "@/components/room-log-page";

export default async function RoomLogsRoute({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomLogPage roomId={roomId} />;
}
