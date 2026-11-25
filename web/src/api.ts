export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const multipart = typeof FormData !== "undefined" && options.body instanceof FormData;
  const response = await fetch("/api" + path, {
    ...options, credentials: "same-origin",
    headers: Object.assign({}, options.body && !multipart ? { "Content-Type": "application/json" } : {}, options.headers ?? {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(result.error || "ทำรายการไม่สำเร็จ กรุณาลองอีกครั้ง", response.status);
  return result as T;
}
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
