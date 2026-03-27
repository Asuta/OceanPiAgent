import assert from "node:assert/strict";
import test from "node:test";
import { parseFeishuMessageContent } from "@/lib/server/channels/feishu/message-content";

test("parseFeishuMessageContent extracts text content", () => {
  const parsed = parseFeishuMessageContent("text", JSON.stringify({ text: "Hello from Feishu" }));
  assert.equal(parsed.text, "Hello from Feishu");
  assert.deepEqual(parsed.imageKeys, []);
});

test("parseFeishuMessageContent extracts image keys from image messages", () => {
  const parsed = parseFeishuMessageContent("image", JSON.stringify({ image_key: "img_123" }));
  assert.deepEqual(parsed.imageKeys, ["img_123"]);
  assert.equal(parsed.placeholderText, "[Feishu image message]");
});

test("parseFeishuMessageContent extracts text and images from post messages", () => {
  const parsed = parseFeishuMessageContent("post", JSON.stringify({
    zh_cn: {
      title: "A title",
      content: [
        [
          { tag: "text", text: "Describe this image" },
          { tag: "img", image_key: "img_post_1" },
        ],
      ],
    },
  }));

  assert.equal(parsed.text, "A title\nDescribe this image");
  assert.deepEqual(parsed.imageKeys, ["img_post_1"]);
});
