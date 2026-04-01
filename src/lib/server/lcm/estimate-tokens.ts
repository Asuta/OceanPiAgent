const CJK_RE = /[\u2E80-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\uAC00-\uD7AF\u3040-\u309F\u30A0-\u30FF\uFF00-\uFFEF\u3000-\u303F]/u;

export function estimateTokens(value: string): number {
  const text = value.trim();
  if (!text) {
    return 0;
  }

  let tokens = 0;
  for (const char of text) {
    if (/\s/u.test(char)) {
      continue;
    }
    tokens += CJK_RE.test(char) ? 1 : 0.25;
  }
  return Math.max(1, Math.ceil(tokens));
}
