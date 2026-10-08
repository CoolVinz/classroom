export class HttpError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 503, message: string) {
    super(message);
  }
}
