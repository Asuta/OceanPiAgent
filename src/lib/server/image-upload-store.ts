import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ALLOWED_MESSAGE_IMAGE_MIME_TYPES,
  MAX_MESSAGE_IMAGE_BYTES,
} from "@/lib/chat/message-attachments";
import type { MessageImageAttachment } from "@/lib/chat/types";
import { createUuid } from "@/lib/utils/uuid";

const UPLOAD_ROOT = path.join(process.cwd(), ".oceanking", "uploads");
const IMAGE_UPLOAD_DIR = path.join(UPLOAD_ROOT, "images");

const MIME_TYPE_TO_EXTENSION: Record<(typeof ALLOWED_MESSAGE_IMAGE_MIME_TYPES)[number], string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

function sanitizeFilename(filename: string): string {
  const normalized = path.basename(filename || "image").replace(/[^a-zA-Z0-9._-]+/g, "-");
  return normalized.replace(/^-+|-+$/g, "") || "image";
}

async function ensureImageUploadDir(): Promise<void> {
  await mkdir(IMAGE_UPLOAD_DIR, { recursive: true });
}

function assertValidMimeType(mimeType: string): asserts mimeType is (typeof ALLOWED_MESSAGE_IMAGE_MIME_TYPES)[number] {
  if (!ALLOWED_MESSAGE_IMAGE_MIME_TYPES.includes(mimeType as (typeof ALLOWED_MESSAGE_IMAGE_MIME_TYPES)[number])) {
    throw new Error("Only PNG, JPEG, and WebP images are supported.");
  }
}

function buildAttachmentUrl(storagePath: string): string {
  return `/api/uploads/image/${storagePath}`;
}

function resolveStoredImagePath(storagePath: string): string {
  const normalized = storagePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) {
    throw new Error("Missing image storage path.");
  }

  const resolved = path.resolve(UPLOAD_ROOT, normalized);
  const relative = path.relative(UPLOAD_ROOT, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid image storage path.");
  }
  return resolved;
}

export function getImageStoragePathFromRouteSegments(segments: string[]): string {
  const joined = segments.join("/").replace(/\\/g, "/").replace(/^\/+/, "");
  resolveStoredImagePath(joined);
  return joined;
}

export async function storeUploadedImage(file: File): Promise<MessageImageAttachment> {
  if (file.size <= 0) {
    throw new Error("The selected image is empty.");
  }
  if (file.size > MAX_MESSAGE_IMAGE_BYTES) {
    throw new Error(`Each image must be ${Math.floor(MAX_MESSAGE_IMAGE_BYTES / (1024 * 1024))} MB or smaller.`);
  }

  assertValidMimeType(file.type);
  await ensureImageUploadDir();

  const id = createUuid();
  const extension = MIME_TYPE_TO_EXTENSION[file.type];
  const filename = sanitizeFilename(file.name);
  const storagePath = path.posix.join("images", `${id}${extension}`);
  const absolutePath = resolveStoredImagePath(storagePath);
  const buffer = Buffer.from(await file.arrayBuffer());

  await writeFile(absolutePath, buffer);

  return {
    id,
    kind: "image",
    mimeType: file.type,
    filename,
    sizeBytes: buffer.byteLength,
    storagePath,
    url: buildAttachmentUrl(storagePath),
  };
}

export async function readStoredImageAttachment(attachment: Pick<MessageImageAttachment, "storagePath" | "mimeType">): Promise<Buffer> {
  assertValidMimeType(attachment.mimeType);
  return readFile(resolveStoredImagePath(attachment.storagePath));
}

export async function readStoredImageByStoragePath(storagePath: string): Promise<Buffer> {
  return readFile(resolveStoredImagePath(storagePath));
}
