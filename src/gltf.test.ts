import { expect, test } from "bun:test";
import { inspectGLTF } from "./gltf";
import { gltfBytes, syntheticGLB, syntheticGLTF } from "./test-fixtures/gltf";
import { validateUpload } from "./file-storage";

test("accepts self-contained glTF and GLB as one model upload", async () => {
  for (const binary of [false, true]) {
    const bytes = binary ? syntheticGLB() : gltfBytes(syntheticGLTF());
    expect(inspectGLTF(bytes, binary).json.nodes).toHaveLength(2);
    const result = await validateUpload(new File([bytes], "sample." + (binary ? "glb" : "gltf")), "model");
    expect(result.mediaType).toBe(binary ? "model/gltf-binary" : "model/gltf+json");
  }
});
test("rejects external resources, compression, malformed ranges and cyclic scenes", () => {
  for (const uri of ["https://example.com/model.bin", "texture.png", "../data.bin", "//example.com/data"]) {
    const model = syntheticGLTF(); model.buffers[0]!.uri = uri;
    expect(() => inspectGLTF(gltfBytes(model), false)).toThrow();
  }
  expect(() => inspectGLTF(gltfBytes({ ...syntheticGLTF(), extensionsRequired: ["KHR_draco_mesh_compression"] }), false)).toThrow();
  const invalid = syntheticGLTF(); invalid.bufferViews[0]!.byteLength = 1000;
  expect(() => inspectGLTF(gltfBytes(invalid), false)).toThrow();
  const cycle = { ...syntheticGLTF(), nodes: [{ children: [0] }] };
  expect(() => inspectGLTF(gltfBytes(cycle), false)).toThrow();
  expect(() => inspectGLTF(syntheticGLB().slice(0, 30), true)).toThrow();
  expect(() => inspectGLTF(gltfBytes({ asset: { version: "1.0" } }), false)).toThrow();
});

test("embedded image validation accepts PNG/JPEG and rejects oversized or corrupt images", async () => {
  const sharp = (await import("sharp")).default;
  for (const format of ["png", "jpeg"] as const) {
    const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#44aa88" } }).toFormat(format).toBuffer();
    const model = { ...syntheticGLTF(), images: [{ uri: "data:image/" + format + ";base64," + image.toString("base64") }] };
    await expect(validateUpload(new File([gltfBytes(model)], "image.gltf"), "model")).resolves.toMatchObject({ mediaType: "model/gltf+json" });
  }
  const image = await sharp({ create: { width: 4096, height: 4096, channels: 3, background: "#44aa88" } }).png().toBuffer();
  await expect(validateUpload(new File([gltfBytes({ ...syntheticGLTF(), images: [{ uri: "data:image/png;base64," + image.toString("base64") }] })], "too-large.gltf"), "model")).rejects.toThrow();
  await expect(validateUpload(new File([gltfBytes({ ...syntheticGLTF(), images: [{ uri: "data:image/png;base64,iVBORw==" }] })], "broken.gltf"), "model")).rejects.toThrow();
});
