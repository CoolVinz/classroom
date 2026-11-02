import * as THREE from "three";

export type ModelPart = { positions: Float32Array; normals: Float32Array; indices?: Uint32Array };
type ModelData = { parts: ModelPart[]; triangles: number };
type WorkerReply = Partial<ModelData> & { error?: string };
type ModelFile = { id: string; originalName: string };

export async function loadModel(file: ModelFile, contentPath: string, signal: AbortSignal): Promise<ModelData> {
  const extension = file.originalName.split(".").pop()?.toLowerCase();
  if (extension !== "stl" && extension !== "obj") throw new Error("รองรับไฟล์ STL และ OBJ เท่านั้น");
  const response = await fetch(contentPath, { credentials: "same-origin", signal });
  if (!response.ok) {
    const result = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof result?.error === "string" ? result.error : "โมเดลนี้ไม่พร้อมแสดงตัวอย่าง");
  }
  const buffer = await response.arrayBuffer();
  signal.throwIfAborted();
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

let thumbnailQueue: Promise<unknown> = Promise.resolve();

export function renderModelThumbnail(file: ModelFile, contentPath: string, signal: AbortSignal): Promise<string> {
  // Render one model at a time so a class list does not hold many WebGL contexts.
  const task = thumbnailQueue.then(async () => {
    signal.throwIfAborted();
    const model = await loadModel(file, contentPath, signal);
    signal.throwIfAborted();
    const view = createModelView(model.parts);
    let renderer: THREE.WebGLRenderer | undefined;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(256, 192, false);
      view.camera.aspect = 4 / 3; view.camera.updateProjectionMatrix();
      renderer.render(view.scene, view.camera);
      return renderer.domElement.toDataURL("image/png");
    } finally { view.dispose(); renderer?.dispose(); renderer?.forceContextLoss(); }
  });
  thumbnailQueue = task.catch(() => {});
  return task;
}
