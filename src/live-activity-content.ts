export type ActivityKind = "quiz" | "discussion" | "poll" | "word-cloud";
export type PollMode = "private" | "walk";
export type PollSnapshot = { mode: PollMode; choices: string[] };
export type CloudTerm = { text: string; count: number };

export function termKey(text: string) {
  return text.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function wordCloud(ideas: { text: string; approved: boolean }[]): CloudTerm[] {
  const terms = new Map<string, CloudTerm>();
  for (const { text, approved } of ideas) {
    if (!approved) continue;
    const key = termKey(text);
    const term = terms.get(key);
    if (term) term.count++;
    else terms.set(key, { text, count: 1 });
  }
  return [...terms.values()].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, "th"));
}
