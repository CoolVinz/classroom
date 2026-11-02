import { expect, spyOn, test } from "bun:test";
import * as THREE from "three";
import { createModelView, loadModel } from "./model-view";

test("model framing centers offset geometry and releases its resources", () => {
  const original = new THREE.BoxGeometry(2, 3, 4);
  original.translate(100, 200, 300);
  const view = createModelView([{
    positions: new Float32Array(original.getAttribute("position").array),
    normals: new Float32Array(original.getAttribute("normal").array),
    indices: new Uint32Array(original.getIndex()!.array),
  }]);
  const bounds = new THREE.Box3().setFromObject(view.scene);
  expect(bounds.getCenter(new THREE.Vector3()).length()).toBeLessThan(0.0001);
  view.camera.updateMatrixWorld();
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const projected = new THREE.Vector3(x, y, z).project(view.camera);
    expect(Math.abs(projected.x)).toBeLessThan(1);
    expect(Math.abs(projected.y)).toBeLessThan(1);
  }
  let geometriesDisposed = 0; let materialsDisposed = 0;
  view.scene.traverse((object) => { if (object instanceof THREE.Mesh) object.geometry.addEventListener("dispose", () => geometriesDisposed++); });
  view.materials.forEach((material) => material.addEventListener("dispose", () => materialsDisposed++));
  view.dispose(); original.dispose();
  expect(geometriesDisposed).toBe(1);
  expect(materialsDisposed).toBe(1);
  expect(view.scene.children).toHaveLength(0);
  expect(() => createModelView([])).toThrow("อ่านโมเดลไม่สำเร็จ");
});

test("model loading cancels its parser and uses the private file request", async () => {
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  let terminated = 0;
  let started!: () => void;
  const parsing = new Promise<void>((resolve) => { started = resolve; });
  class ParserWorker {
    postMessage() { started(); }
    terminate() { terminated++; }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: ParserWorker });
  const request = spyOn(globalThis, "fetch").mockResolvedValue(new Response("synthetic model"));
  try {
    const controller = new AbortController();
    const pending = loadModel({ id: "sample", originalName: "sample.stl" }, "/api/files/sample/content", controller.signal);
    const rejected = pending.catch((error) => error);
    await parsing;
    controller.abort();
    expect(await rejected).toMatchObject({ name: "AbortError" });
    expect(terminated).toBe(1);
    expect(request).toHaveBeenCalledWith("/api/files/sample/content", { credentials: "same-origin", signal: controller.signal });
  } finally {
    request.mockRestore();
    if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker);
    else Reflect.deleteProperty(globalThis, "Worker");
  }
});
