import { NextResponse } from "next/server";
import { storeUploadedImage } from "@/lib/server/image-upload-store";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Please provide an image file." }, { status: 400 });
    }

    const attachment = await storeUploadedImage(file);
    return NextResponse.json({ attachment });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
