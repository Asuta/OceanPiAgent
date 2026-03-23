import { RoomDetailPage } from "@/components/room-detail-page";

export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <RoomDetailPage roomId={roomId} />;
}
