import { expect, test } from "bun:test";
import * as THREE from "three";
import { galleryModelIdForHit } from "./gallery-picking";

test("gallery model picks resolve nested uploaded geometry, not unrelated scene objects", () => {
  const roots = new WeakMap<THREE.Object3D, string>();
  const model = new THREE.Group(), nested = new THREE.Group(), mesh = new THREE.Mesh(new THREE.BoxGeometry());
  model.add(nested); nested.add(mesh); roots.set(model, "model-1");
  expect(galleryModelIdForHit(mesh, roots)).toBe("model-1");
  expect(galleryModelIdForHit(new THREE.Mesh(new THREE.BoxGeometry()), roots)).toBeNull();
});
