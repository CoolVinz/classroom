import * as THREE from "three";

export type ModelPart = { positions: Float32Array; normals: Float32Array; indices?: Uint32Array };
type ModelData = { parts: ModelPart[]; triangles: number };
type WorkerReply = Partial<ModelData> & { error?: string };
type ModelFile = { id: string; originalName: string };

async function parseModel(file: ModelFile, buffer: ArrayBuffer, signal: AbortSignal): Promise<ModelData> {
  const extension = file.originalName.split(".").pop()?.toLowerCase();
  if (extension !== "stl" && extension !== "obj") throw new Error("รองรับไฟล์ STL และ OBJ เท่านั้น");
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./model-preview.worker.ts", import.meta.url), { type: "module" });
    const cleanup = () => { clearTimeout(timer); worker.terminate(); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => {
      cleanup(); reject(new Error("ใช้เวลาอ่านโมเดลนานเกินไป กรุณาดาวน์โหลดไฟล์เพื่อตรวจสอบ"));
    }, 10_000);
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      cleanup();
      if (data.error || !data.parts?.length || !data.triangles) reject(new Error(data.error ?? "อ่านโมเดลไม่สำเร็จ"));
      else resolve({ parts: data.parts, triangles: data.triangles });
    };
    worker.onerror = () => { cleanup(); reject(new Error("อ่านโมเดลไม่สำเร็จ")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else worker.postMessage({ extension, buffer }, [buffer]);
  });
}

async function readModel(file: ModelFile, contentPath: string, signal: AbortSignal): Promise<ModelData> {
  const response = await fetch(contentPath, { credentials: "same-origin", signal });
  if (!response.ok) {
    const result = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof result?.error === "string" ? result.error : "โมเดลนี้ไม่พร้อมแสดงตัวอย่าง");
  }
  return parseModel(file, await response.arrayBuffer(), signal);
}

export function loadModel(file: ModelFile, contentPath: string, signal: AbortSignal) {
  return readModel(file, contentPath, signal);
}

export type ThumbnailFile = ModelFile & { mediaType: string };
let thumbnailQueue: Promise<unknown> = Promise.resolve();

function enqueueThumbnail<T>(task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  const next = thumbnailQueue.then(async () => {
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException("Thumbnail timed out", "TimeoutError")), 15_000);
    try { return await task(controller.signal); }
    finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  });
  thumbnailQueue = next.catch(() => {});
  return next;
}

function canvasBlob(canvas: HTMLCanvasElement, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new DOMException("Cancelled", "AbortError")); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    canvas.toBlob((blob) => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
      else if (blob) resolve(blob);
      else reject(new Error("สร้างภาพตัวอย่างไม่สำเร็จ"));
    }, "image/png");
  });
}

async function renderModelBlob(parts: ModelPart[], signal: AbortSignal) {
  const view = createModelView(parts);
  let renderer: THREE.WebGLRenderer | undefined;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(256, 192, false);
    view.camera.aspect = 4 / 3; view.camera.updateProjectionMatrix();
    renderer.render(view.scene, view.camera);
    signal.throwIfAborted();
    return await canvasBlob(renderer.domElement, signal);
  } finally { view.dispose(); renderer?.dispose(); renderer?.forceContextLoss(); }
}

async function renderImageBlob(file: File, signal: AbortSignal) {
  const bitmapPromise = createImageBitmap(file);
  void bitmapPromise.then((bitmap) => { if (signal.aborted) bitmap.close(); }).catch(() => {});
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  const bitmap = await Promise.race([bitmapPromise, aborted]).finally(() => {
    if (abort) signal.removeEventListener("abort", abort);
  });
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 192;
  const context = canvas.getContext("2d");
  if (!context) { bitmap.close(); throw new Error("สร้างภาพตัวอย่างไม่สำเร็จ"); }
  context.fillStyle = "#f7faf8"; context.fillRect(0, 0, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
  const width = bitmap.width * scale; const height = bitmap.height * scale;
  context.drawImage(bitmap, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  bitmap.close(); signal.throwIfAborted();
  return canvasBlob(canvas, signal);
}

export function createThumbnailFromFile(file: File & { name: string }, mediaType: string, signal: AbortSignal) {
  return enqueueThumbnail(async (activeSignal) => {
    if (mediaType.startsWith("image/")) return renderImageBlob(file, activeSignal);
    const model = await parseModel({ id: file.name, originalName: file.name }, await file.arrayBuffer(), activeSignal);
    return renderModelBlob(model.parts, activeSignal);
  }, signal);
}

export function createThumbnailFromUrl(file: ThumbnailFile, contentPath: string, signal: AbortSignal) {
  return enqueueThumbnail(async (activeSignal) => {
    if (file.mediaType.startsWith("image/")) {
      const response = await fetch(contentPath, { credentials: "same-origin", signal: activeSignal });
      if (!response.ok) throw new Error("ไฟล์นี้ไม่พร้อมแสดงตัวอย่าง");
      const original = new File([await response.blob()], file.originalName, { type: file.mediaType });
      return renderImageBlob(original, activeSignal);
    }
    const model = await readModel(file, contentPath, activeSignal);
    activeSignal.throwIfAborted();
    return renderModelBlob(model.parts, activeSignal);
  }, signal);
}

export function createModelView(parts: ModelPart[]) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#f7faf8");
  scene.add(new THREE.HemisphereLight(0xffffff, 0x7d8d87, 2));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
  keyLight.position.set(4, 7, 6); scene.add(keyLight);
  const object = new THREE.Group();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.MeshStandardMaterial[] = [];
  const dispose = () => { geometries.forEach((item) => item.dispose()); materials.forEach((item) => item.dispose()); scene.clear(); };
  try {
    for (const part of parts) {
      const geometry = new THREE.BufferGeometry();
      geometries.push(geometry);
      geometry.setAttribute("position", new THREE.BufferAttribute(part.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(part.normals, 3));
      if (part.indices) geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
      const material = new THREE.MeshStandardMaterial({ color: 0x4b9a80, metalness: 0.05, roughness: 0.7 });
      materials.push(material); object.add(new THREE.Mesh(geometry, material));
    }
    scene.add(object);
    const bounds = new THREE.Box3().setFromObject(object);
    const radius = Math.max(bounds.getBoundingSphere(new THREE.Sphere()).radius, 0.1);
    if (bounds.isEmpty() || !Number.isFinite(radius)) throw new Error("อ่านโมเดลไม่สำเร็จ");
    object.position.sub(bounds.getCenter(new THREE.Vector3()));
    const camera = new THREE.PerspectiveCamera(38, 1, radius / 1000, radius * 100);
    camera.position.set(radius * 2.6, radius * 2.1, radius * 2.6);
    camera.lookAt(0, 0, 0);
    return { scene, camera, materials, dispose };
  } catch (error) { dispose(); throw error; }
}
