export type SourceRange = { start: number; end: number };

export function lessonImageTag(id: string, alt: string) {
  const escaped = alt.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<img src="lesson-image://${id}" alt="${escaped}">`;
}

export function findImageSource(html: string, selection: SourceRange): SourceRange | "responsive" | null {
  const tags = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-z][\w:-]*)(?=[\s/>])(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  let pictureDepth = 0;
  const rawText = /^(script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/;
  let tag: RegExpExecArray | null;
  while ((tag = tags.exec(html))) {
    const start = tag.index;
    if (start > selection.start) break;
    if (!tag[2]) continue;
    const end = start + tag[0].length;
    const name = tag[2].toLowerCase();
    if (!tag[1] && rawText.test(name)) {
      if (name === "plaintext") break;
      const closing = new RegExp(`</${name}\\s*>`, "gi");
      closing.lastIndex = end;
      if (!closing.test(html)) break;
      tags.lastIndex = closing.lastIndex;
      continue;
    }
    if (name === "picture") pictureDepth = Math.max(0, pictureDepth + (tag[1] ? -1 : 1));
    if (name !== "img" || tag[1] || selection.start >= end || selection.end > end) continue;
    if (pictureDepth) return "responsive";

    const attributes = /\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gd;
    let src: SourceRange | null = null;
    for (const attribute of tag[0].matchAll(attributes)) {
      if (attribute[1].toLowerCase() === "srcset") return "responsive";
      if (attribute[1].toLowerCase() !== "src") continue;
      const range = attribute.indices?.slice(2).find(Boolean);
      if (src || !range) return null;
      src = { start: start + range[0], end: start + range[1] };
    }
    return src;
  }
  return null;
}
