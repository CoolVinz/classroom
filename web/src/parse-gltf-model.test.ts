import { afterAll, expect, test } from "bun:test";
import * as THREE from "three";
import { parseGLTFModel } from "./parse-gltf-model";
import { createModelObject, disposeModelObject } from "./model-view";
import { gltfBytes, syntheticGLB, syntheticGLTF } from "../../src/test-fixtures/gltf";

const oldProgressEvent = Object.getOwnPropertyDescriptor(globalThis, "ProgressEvent");
if (!oldProgressEvent) Object.defineProperty(globalThis, "ProgressEvent", { configurable: true, value: class extends Event { constructor(type: string, values: object) { super(type); Object.assign(this, values); } } });
afterAll(() => { if (!oldProgressEvent) Reflect.deleteProperty(globalThis, "ProgressEvent"); });

test("GLB and glTF preserve multiple meshes, transforms and material colors", async () => {
  for (const binary of [false, true]) {
    const model = await parseGLTFModel(binary ? syntheticGLB() : gltfBytes(syntheticGLTF()), binary);
    expect(model.triangles).toBe(2);
    const object = createModelObject(model);
    const bounds = new THREE.Box3().setFromObject(object);
    expect(bounds.min.x).toBe(-2); expect(bounds.max.x).toBe(11);
    expect(bounds.max.y).toBe(21); expect(bounds.max.z).toBe(30);
    let meshes = 0;
    object.traverse((item) => {
      if (item instanceof THREE.Mesh) { meshes++; expect((item.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0xff0000); }
    });
    expect(meshes).toBe(2);
    disposeModelObject(object);
  }
});
test("serialized embedded texture data survives reconstruction and disposal", () => {
  const texture = new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1);
  const original = new THREE.Group();
  original.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({ map: texture })));
  const object = createModelObject({ parts: [], triangles: 2, scene: original.toJSON() });
  let disposed = 0;
  object.traverse((item) => {
    if (item instanceof THREE.Mesh) {
      const map = (item.material as THREE.MeshStandardMaterial).map!;
      expect((map.image as { width: number }).width).toBe(1);
      map.addEventListener("dispose", () => disposed++);
    }
  });
  disposeModelObject(object); disposeModelObject(original);
  expect(disposed).toBe(1);
});
