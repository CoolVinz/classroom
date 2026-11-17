import * as THREE from "three";

export type ModelPart = { positions: Float32Array; normals: Float32Array; indices?: Uint32Array; colors?: Float32Array };
export type ModelData = { parts: ModelPart[]; triangles: number; scene?: ReturnType<THREE.Object3D["toJSON"]>; textureBytes?: number };
type WorkerReply = Partial<ModelData> & { error?: string };
type ModelFile = { id: string; originalName: string };

async function parseModel(file: ModelFile, buffer: ArrayBuffer, signal: AbortSignal, materialText?: string): Promise<ModelData> {
  const extension = file.originalName.split(".").pop()?.toLowerCase();
  if (extension !== "stl" && extension !== "obj" && extension !== "glb" && extension !== "gltf") throw new Error("รองรับไฟล์ STL, OBJ, GLB และ glTF");
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./model-preview.worker.ts", import.meta.url), { type: "module" });
    const cleanup = () => { clearTimeout(timer); worker.terminate(); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    const timer = setTimeout(() => {
      cleanup(); reject(new Error("ใช้เวลาอ่านโมเดลนานเกินไป กรุณาดาวน์โหลดไฟล์เพื่อตรวจสอบ"));
    }, 10_000);
    worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      cleanup();
      if (data.error || (!data.parts?.length && !data.scene) || !data.triangles) reject(new Error(data.error ?? "อ่านโมเดลไม่สำเร็จ"));
      else resolve({ parts: data.parts ?? [], triangles: data.triangles, scene: data.scene, textureBytes: data.textureBytes });
    };
    worker.onerror = () => { cleanup(); reject(new Error("อ่านโมเดลไม่สำเร็จ")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else worker.postMessage({ extension, buffer, materialText }, [buffer]);
  });
}

async function readModel(file: ModelFile, contentPath: string, signal: AbortSignal, materialPath?: string): Promise<ModelData> {
  const [response, materialResponse] = await Promise.all([
    fetch(contentPath, { credentials: "same-origin", signal }),
    materialPath ? fetch(materialPath, { credentials: "same-origin", signal }).catch(() => null) : Promise.resolve(null),
  ]);
  if (!response.ok) {
    const result = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof result?.error === "string" ? result.error : "โมเดลนี้ไม่พร้อมแสดงตัวอย่าง");
  }
  const materialText = materialResponse?.ok ? await materialResponse.text() : undefined;
  return parseModel(file, await response.arrayBuffer(), signal, materialText);
}

export function loadModel(file: ModelFile, contentPath: string, signal: AbortSignal, materialPath?: string) {
  return readModel(file, contentPath, signal, materialPath);
}

export type ThumbnailFile = ModelFile & { mediaType: string; materialAvailable?: boolean };
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

async function renderModelBlob(model: ModelData, signal: AbortSignal) {
  const view = createModelView(model);
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

export function createThumbnailFromFile(file: File & { name: string }, mediaType: string, signal: AbortSignal, materialFile?: File) {
  return enqueueThumbnail(async (activeSignal) => {
    if (mediaType.startsWith("image/")) return renderImageBlob(file, activeSignal);
    const model = await parseModel({ id: file.name, originalName: file.name }, await file.arrayBuffer(), activeSignal, materialFile ? await materialFile.text() : undefined);
    return renderModelBlob(model, activeSignal);
  }, signal);
}

export function createThumbnailFromUrl(file: ThumbnailFile, contentPath: string, signal: AbortSignal, materialPath?: string) {
  return enqueueThumbnail(async (activeSignal) => {
    if (file.mediaType.startsWith("image/")) {
      const response = await fetch(contentPath, { credentials: "same-origin", signal: activeSignal });
      if (!response.ok) throw new Error("ไฟล์นี้ไม่พร้อมแสดงตัวอย่าง");
      const original = new File([await response.blob()], file.originalName, { type: file.mediaType });
      return renderImageBlob(original, activeSignal);
    }
    const model = await readModel(file, contentPath, activeSignal, materialPath);
    activeSignal.throwIfAborted();
    return renderModelBlob(model, activeSignal);
  }, signal);
}

export function disposeModelObject(object: THREE.Object3D) {
  const textures = new Set<THREE.Texture>();
  object.traverse((item) => {
    const mesh = item as THREE.Mesh;
    mesh.geometry?.dispose();
    for (const material of mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : []) {
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      material.dispose();
    }
  });
  textures.forEach((texture) => texture.dispose());
}

export function createModelObject(model: ModelData): THREE.Group {
  const object = new THREE.Group();
  if (model.scene) object.add(new THREE.ObjectLoader().parse(model.scene));
  else for (const part of model.parts) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(part.positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(part.normals, 3));
    if (part.indices) geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
    if (part.colors) geometry.setAttribute("color", new THREE.BufferAttribute(part.colors, 3));
    object.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: part.colors ? 0xffffff : 0x4b9a80, vertexColors: Boolean(part.colors), metalness: 0.05, roughness: 0.7 })));
  }
  return object;
}

export function createModelView(model: ModelData) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#f7faf8");
  scene.add(new THREE.HemisphereLight(0xffffff, 0x7d8d87, 2));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
  keyLight.position.set(4, 7, 6); scene.add(keyLight);
  const object = createModelObject(model);
  const materials: THREE.MeshStandardMaterial[] = [];
  object.traverse((item) => {
    const mesh = item as THREE.Mesh;
    if (mesh.material) materials.push(...(Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]);
  });
  const dispose = () => { disposeModelObject(object); scene.clear(); };
  try {
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
