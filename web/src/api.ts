export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const multipart = typeof FormData !== "undefined" && options.body instanceof FormData;
  const response = await fetch("/api" + path, {
    ...options, credentials: "same-origin",
    headers: Object.assign({}, options.body && !multipart ? { "Content-Type": "application/json" } : {}, options.headers ?? {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "ทำรายการไม่สำเร็จ กรุณาลองอีกครั้ง");
  return result as T;
}
