import { expect, spyOn, test } from "bun:test";
import * as THREE from "three";
import { createPresentBlast, createPresentModel, createSantaModel, disposeSantaModel } from "./gallery-santa";

test("Santa, gifts, and the five-unit warning ring use disposable low-poly meshes", () => {
  const models = [createSantaModel(), createPresentModel(), createPresentBlast()];
  let meshes = 0;
  for (const model of models) model.traverse((node) => { if (node instanceof THREE.Mesh) meshes++; });
  expect(meshes).toBeGreaterThan(10);
  expect(models[2]!.scale.x).toBe(5);
  const disposeGeometry = spyOn(THREE.BufferGeometry.prototype, "dispose").mockImplementation(() => {});
  const disposeMaterial = spyOn(THREE.Material.prototype, "dispose").mockImplementation(() => {});
  for (const model of models) disposeSantaModel(model);
  expect(disposeGeometry).toHaveBeenCalledTimes(meshes);
  expect(disposeMaterial).toHaveBeenCalledTimes(meshes);
  disposeGeometry.mockRestore(); disposeMaterial.mockRestore();
});
