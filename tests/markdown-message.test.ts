import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownMessage } from "@/components/markdown-message";

test("MarkdownMessage renders GitHub-flavored markdown for assistant replies", () => {
  const html = renderToStaticMarkup(
    React.createElement(MarkdownMessage, {
      className: "thread-message-body markdown-body",
      content: "# Title\n\n- first\n- second\n\n```ts\nconst value = 1;\n```\n\n[OceanKing](https://example.com)",
    }),
  );

  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<li>first<\/li>/);
  assert.match(html, /<code class="[^"]*language-ts[^"]*">/);
  assert.match(html, /const value = 1;/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noreferrer"/);
});

test("MarkdownMessage drops raw HTML instead of injecting it", () => {
  const html = renderToStaticMarkup(
    React.createElement(MarkdownMessage, {
      content: "safe<script>alert('xss')</script>text",
    }),
  );

  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /alert\('xss'\)/);
});
