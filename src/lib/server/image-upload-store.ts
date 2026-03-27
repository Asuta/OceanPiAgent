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

function inferExtensionFromFilename(filename: string): string | null {
  const extension = path.extname(filename || "").toLowerCase();
  return extension || null;
}

async function ensureImageUploadDir(): Promise<void> {
  await mkdir(IMAGE_UPLOAD_DIR, { recursive: true });
}

function assertValidMimeType(mimeType: string): asserts mimeType is (typeof ALLOWED_MESSAGE_IMAGE_MIME_TYPES)[number] {
  if (!ALLOWED_MESSAGE_IMAGE_MIME_TYPES.includes(mimeType as (typeof ALLOWED_MESSAGE_IMAGE_MIME_TYPES)[number])) {
    throw new Error("Only PNG, JPEG, and WebP images are supported.");
  }
}

export function detectAllowedImageMimeType(args: {
  mimeType?: string | null;
  filename?: string | null;
  buffer?: Buffer;
}): (typeof ALLOWED_MESSAGE_IMAGE_MIME_TYPES)[number] | null {
  const normalizedMimeType = args.mimeType?.trim().toLowerCase() || "";
  if (normalizedMimeType === "image/jpg") {
    return "image/jpeg";
  }
  if (ALLOWED_MESSAGE_IMAGE_MIME_TYPES.includes(normalizedMimeType as (typeof ALLOWED_MESSAGE_IMAGE_MIME_TYPES)[number])) {
    return normalizedMimeType as (typeof ALLOWED_MESSAGE_IMAGE_MIME_TYPES)[number];
  }

  const extension = inferExtensionFromFilename(args.filename || "");
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }

  const buffer = args.buffer;
  if (!buffer || buffer.byteLength < 12) {
    return null;
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
    && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
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
  const buffer = Buffer.from(await file.arrayBuffer());
  return storeImageBufferAsAttachment({
    buffer,
    mimeType: file.type,
    filename: file.name,
  });
}

export async function storeImageBufferAsAttachment(args: {
  buffer: Buffer;
  mimeType: string;
  filename?: string;
}): Promise<MessageImageAttachment> {
  if (args.buffer.byteLength <= 0) {
    throw new Error("The selected image is empty.");
  }
  if (args.buffer.byteLength > MAX_MESSAGE_IMAGE_BYTES) {
    throw new Error(`Each image must be ${Math.floor(MAX_MESSAGE_IMAGE_BYTES / (1024 * 1024))} MB or smaller.`);
  }

  const detectedMimeType = detectAllowedImageMimeType({
    mimeType: args.mimeType,
    filename: args.filename,
    buffer: args.buffer,
  });
  if (!detectedMimeType) {
    throw new Error("Only PNG, JPEG, and WebP images are supported.");
  }

  assertValidMimeType(detectedMimeType);
  await ensureImageUploadDir();

  const id = createUuid();
  const extension = MIME_TYPE_TO_EXTENSION[detectedMimeType];
  const filename = sanitizeFilename(args.filename || `image${extension}`);
  const storagePath = path.posix.join("images", `${id}${extension}`);
  const absolutePath = resolveStoredImagePath(storagePath);

  await writeFile(absolutePath, args.buffer);

  return {
    id,
    kind: "image",
    mimeType: detectedMimeType,
    filename,
    sizeBytes: args.buffer.byteLength,
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
