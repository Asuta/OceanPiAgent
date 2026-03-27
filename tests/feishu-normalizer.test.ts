import assert from "node:assert/strict";
import test from "node:test";
import type { MessageImageAttachment } from "@/lib/chat/types";
import { normalizeFeishuInboundMessage } from "@/lib/server/channels/feishu/message-normalizer";

const SAMPLE_ATTACHMENT: MessageImageAttachment = {
  id: "image-1",
  kind: "image",
  mimeType: "image/jpeg",
  filename: "photo.jpg",
  sizeBytes: 2048,
  storagePath: "images/photo.jpg",
  url: "/api/uploads/image/images/photo.jpg",
};

const FEISHU_CONFIG = {
  enabled: true,
  configured: true,
  accountId: "default",
  appId: "app-id",
  appSecret: "app-secret",
  defaultAgentId: "concierge",
  allowOpenIds: [],
};

test("normalizeFeishuInboundMessage converts image messages into attachments", async () => {
  const message = await normalizeFeishuInboundMessage({
    config: FEISHU_CONFIG,
    event: {
      sender: {
        sender_type: "user",
        sender_id: {
          open_id: "ou_image",
        },
      },
      message: {
        message_id: "om_image",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_123" }),
      },
    },
    deps: {
      logger: () => {},
      storeAttachment: async () => SAMPLE_ATTACHMENT,
      getClient: () => ({
        im: {
          messageResource: {
            get: async () => ({
              headers: {
                "content-type": "image/jpeg",
              },
              getReadableStream: () => (async function* () {
                yield Buffer.from("binary");
              })(),
            }),
          },
        },
      }) as never,
    },
  });

  assert.ok(message);
  assert.equal(message?.messageType, "image");
  assert.equal(message?.text, "");
  assert.equal(message?.attachments.length, 1);
  assert.equal(message?.attachments[0]?.filename, "photo.jpg");
});

test("normalizeFeishuInboundMessage keeps post text and images together", async () => {
  const message = await normalizeFeishuInboundMessage({
    config: FEISHU_CONFIG,
    event: {
      sender: {
        sender_type: "user",
        sender_id: {
          open_id: "ou_post",
        },
      },
      message: {
        message_id: "om_post",
        chat_type: "p2p",
        message_type: "post",
        content: JSON.stringify({
          zh_cn: {
            content: [[{ tag: "text", text: "Look at this" }, { tag: "img", image_key: "img_post" }]],
          },
        }),
      },
    },
    deps: {
      logger: () => {},
      storeAttachment: async () => SAMPLE_ATTACHMENT,
      getClient: () => ({
        im: {
          messageResource: {
            get: async () => ({
              headers: {
                "content-type": "image/jpeg",
              },
              getReadableStream: () => (async function* () {
                yield Buffer.from("binary");
              })(),
            }),
          },
        },
      }) as never,
    },
  });

  assert.ok(message);
  assert.equal(message?.messageType, "post");
  assert.equal(message?.text, "Look at this");
  assert.equal(message?.attachments.length, 1);
});

test("normalizeFeishuInboundMessage turns unsupported media into placeholders", async () => {
  const message = await normalizeFeishuInboundMessage({
    config: FEISHU_CONFIG,
    event: {
      sender: {
        sender_type: "user",
        sender_id: {
          open_id: "ou_file",
        },
      },
      message: {
        message_id: "om_file",
        chat_type: "p2p",
        message_type: "file",
        content: JSON.stringify({ file_key: "file_1", file_name: "report.pdf" }),
      },
    },
    deps: {
      logger: () => {},
    },
  });

  assert.ok(message);
  assert.equal(message?.messageType, "file");
  assert.equal(message?.text, "[Feishu file message: report.pdf]");
  assert.equal(message?.attachments.length, 0);
});
