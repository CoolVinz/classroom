import { expect, spyOn, test } from "bun:test";
import { generateThumbnail } from "./thumbnail-jobs";

test("shares a thumbnail job without cancelling it while another viewer remains", async () => {
  const modelView = await import("./model-view");
  const thumbnail = new Blob(["preview"], { type: "image/png" });
  let activeSignal: AbortSignal | undefined;
  let finish!: (blob: Blob) => void;
  const render = spyOn(modelView, "createThumbnailFromUrl").mockImplementation((_file, _path, signal) => {
    activeSignal = signal;
    return new Promise((resolve) => { finish = resolve; });
  });
  const request = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));
  try {
    const file = { id: "work-1", originalName: "model.stl", mediaType: "model/stl" };
    const first = new AbortController(); const second = new AbortController();
    const firstView = generateThumbnail(file, "/api/files/work-1/content", "/files/work-1/thumbnail", first.signal);
    const secondView = generateThumbnail(file, "/api/files/work-1/content", "/files/work-1/thumbnail", second.signal);
    await Promise.resolve();
    expect(render).toHaveBeenCalledTimes(1);
    first.abort();
    await expect(firstView).rejects.toMatchObject({ name: "AbortError" });
    expect(activeSignal?.aborted).toBe(false);
    finish(thumbnail);
    await expect(secondView).resolves.toBe(thumbnail);
  } finally {
    request.mockRestore();
    render.mockRestore();
  }
});
