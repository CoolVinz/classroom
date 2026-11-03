import { api } from "./api";
import type { ThumbnailFile } from "./model-view";

type ThumbnailJob = { promise: Promise<Blob>; controller: AbortController; consumers: number };
const jobs = new Map<string, ThumbnailJob>();

export function generateThumbnail(file: ThumbnailFile, contentPath: string, thumbnailPath: string, signal: AbortSignal, source?: File) {
  const key = file.id + ":" + thumbnailPath;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
  let job = jobs.get(key);
  if (!job || job.controller.signal.aborted) {
    const controller = new AbortController();
    const promise = import("./model-view").then(({ createThumbnailFromFile, createThumbnailFromUrl }) => source
      ? createThumbnailFromFile(source, file.mediaType, controller.signal)
      : createThumbnailFromUrl(file, contentPath, controller.signal))
      .then(async (blob) => {
        controller.signal.throwIfAborted();
        const form = new FormData();
        form.set("file", new File([blob], file.id + ".png", { type: "image/png" }));
        await api(thumbnailPath, { method: "PUT", body: form, signal: controller.signal }).catch(() => {});
        controller.signal.throwIfAborted();
        return blob;
      });
    const created = { promise, controller, consumers: 0 };
    jobs.set(key, created);
    void promise.finally(() => { if (jobs.get(key) === created) jobs.delete(key); }).catch(() => {});
    job = created;
  }

  job.consumers++;
  return new Promise<Blob>((resolve, reject) => {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal.removeEventListener("abort", abort);
      job!.consumers--;
      if (!job!.consumers && jobs.get(key) === job) job!.controller.abort(new DOMException("No thumbnail viewers remain", "AbortError"));
    };
    const abort = () => { release(); reject(signal.reason ?? new DOMException("Cancelled", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    job!.promise.then((blob) => { if (signal.aborted) abort(); else { release(); resolve(blob); } }, (error) => { release(); reject(error); });
  });
}
