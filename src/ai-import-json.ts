export const maxAiImportBytes = 1_048_576;

export function readImportJson(source: string): unknown {
  if (new TextEncoder().encode(source).byteLength > maxAiImportBytes) throw new Error("Import text exceeds 1 MiB");
  let text = source.trim();
  if (text.startsWith("```")) {
    const match = text.match(/^```(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```$/i);
    if (!match) throw new Error("Use plain JSON or one complete JSON code fence");
    text = match[1];
  }
  try { return JSON.parse(text); } catch { throw new Error("Invalid JSON. Paste the JSON response only."); }
}

export function importObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path}: expected an object`);
  return value as Record<string, unknown>;
}

export function importFields(value: Record<string, unknown>, required: string[], path: string, optional: string[] = []) {
  const extra = Object.keys(value).find((key) => !required.includes(key) && !optional.includes(key));
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (extra !== undefined) throw new Error(`${path}: unknown field "${extra}"`);
  if (missing !== undefined) throw new Error(`${path}: missing field "${missing}"`);
}

export function importString(value: unknown, path: string, max: number, preserveWhitespace = false) {
  if (typeof value !== "string" || /[\u0000\uD800-\uDFFF]/u.test(value)) throw new Error(`${path}: expected valid text`);
  const result = preserveWhitespace ? value : value.trim();
  if (result.length > max) throw new Error(`${path}: expected text up to ${max} characters`);
  return result;
}
