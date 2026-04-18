export function parseToken(text: string): { route: string; cleaned: string } | null {
  const m = text.match(/autorouter:(\w+)/i);
  if (!m) return null;
  const route = m[1].toLowerCase();
  const cleaned = text.replace(/autorouter:\w+/i, "").replace(/\s+/g, " ").trim();
  return { route, cleaned: cleaned || " " };
}
