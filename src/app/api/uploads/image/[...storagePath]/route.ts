import { NextResponse } from "next/server";
import { getImageStoragePathFromRouteSegments, readStoredImageByStoragePath } from "@/lib/server/image-upload-store";

export const runtime = "nodejs";

function getMimeType(storagePath: string): string {
  const normalized = storagePath.toLowerCase();
  if (normalized.endsWith(".png")) {
    return "image/png";
  }
  if (normalized.endsWith(".webp")) {
    return "image/webp";
  }
  return "image/jpeg";
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ storagePath: string[] }> },
) {
  try {
    const { storagePath } = await context.params;
    const normalizedPath = getImageStoragePathFromRouteSegments(storagePath);
    const buffer = await readStoredImageByStoragePath(normalizedPath);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": getMimeType(normalizedPath),
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch {
    return NextResponse.json({ error: "Image not found." }, { status: 404 });
  }
}
