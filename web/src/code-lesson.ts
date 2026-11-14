export const lessonCodePolicy = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
  "style-src 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://fonts.googleapis.com",
  "font-src data: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://fonts.gstatic.com",
  "img-src data: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://images.unsplash.com",
  "connect-src https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
  "frame-src https://www.youtube-nocookie.com",
].join("; ");

export type CodeBlock = { type: "code"; html: string; css: string; javascript: string; imageIds: string[]; framework?: "none" | "bootstrap" };

export function createCodeLessonDocument(html: string, css = "", javascript = "", framework: CodeBlock["framework"] = "none") {
  const style = css ? `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>` : "";
  const script = javascript ? `<script>${javascript.replace(/<\/script/gi, "<\\/script")}</script>` : "";
  const resources = framework === "bootstrap"
    ? '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.9/dist/css/bootstrap.min.css" integrity="sha384-yEPZ7jP9S0QKiUQ0m3jjsO4ProIW7wvR9gXkI7JOGa2XVsw53Yke2bsdkBbjmmiX" crossorigin="anonymous"><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.9/dist/js/bootstrap.bundle.min.js" integrity="sha384-WyOxWvTyr1QaMPfiPJSv76iReVthorl5uWlFtZPyK0IEB0hGzo9y5Bp9mYanr8Bu" crossorigin="anonymous"></script>'
    : "";
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${lessonCodePolicy}">${resources}${html}${style}${script}`;
}

export async function imageDataUrl(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return `data:${blob.type};base64,${btoa(chunks.join(""))}`;
}

export function lessonImageIds(...sources: string[]) {
  const ids = new Set<string>();
  const marker = /lesson-image:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/gi;
  for (const source of sources) for (const match of source.matchAll(marker)) ids.add(match[1].toLowerCase());
  return [...ids];
}
