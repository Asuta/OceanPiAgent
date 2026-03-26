import type { MessageImageAttachment } from "@/lib/chat/types";

export const ALLOWED_MESSAGE_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MAX_MESSAGE_IMAGE_ATTACHMENTS = 3;
export const MAX_MESSAGE_IMAGE_BYTES = 5 * 1024 * 1024;

export function formatImageAttachmentSummary(attachment: Pick<MessageImageAttachment, "filename" | "sizeBytes">): string {
  const sizeInMb = attachment.sizeBytes / (1024 * 1024);
  return `[Image: ${attachment.filename}${Number.isFinite(sizeInMb) ? `, ${sizeInMb.toFixed(2)} MB` : ""}]`;
}

export function summarizeImageAttachments(attachments: MessageImageAttachment[]): string[] {
  return attachments.map((attachment) => formatImageAttachmentSummary(attachment));
}

export function formatMessageForTranscript(content: string, attachments: MessageImageAttachment[]): string {
  const trimmedContent = content.trim();
  const attachmentLines = summarizeImageAttachments(attachments);
  if (!trimmedContent) {
    return attachmentLines.join("\n");
  }
  if (attachmentLines.length === 0) {
    return trimmedContent;
  }
  return [trimmedContent, ...attachmentLines].join("\n");
}

export function hasMessagePayload(content: string, attachments: MessageImageAttachment[]): boolean {
  return Boolean(content.trim() || attachments.length > 0);
}
