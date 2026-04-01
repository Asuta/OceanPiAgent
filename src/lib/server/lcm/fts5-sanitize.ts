export function sanitizeFts5Query(raw: string): string {
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return '""';
  }
  return tokens.map((token) => `"${token.replace(/"/g, "")}"`).join(" ");
}
