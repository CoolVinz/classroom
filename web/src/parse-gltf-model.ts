import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { inspectGLTF } from "../../src/gltf";

export async function parseGLTFModel(buffer: ArrayBuffer, binary: boolean) {
  const { json } = inspectGLTF(buffer, binary);
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (!url.startsWith("data:") && !url.startsWith("blob:")) throw new Error("ไม่อนุญาตให้โหลดไฟล์ภายนอก glTF");
    return url;
  });
  const result = await new GLTFLoader(manager).parseAsync(binary ? buffer : JSON.stringify(json), "");
  let triangles = 0, textureBytes = 0, decodedBytes = 0;
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  const geometries = new Set<THREE.BufferGeometry>();
  result.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    triangles += (mesh.geometry.index?.count ?? mesh.geometry.getAttribute("position")?.count ?? 0) / 3;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    }
  });
  try {
    if (!triangles || triangles > 500_000) throw new Error("โมเดลต้องมีไม่เกิน 500,000 รูปสามเหลี่ยม");
    const images = new Map<object, { data: Uint8Array; width: number; height: number }>();
    const originalImages = new Map([...textures].map((texture) => [texture, texture.image as ImageBitmap]));
    for (const texture of textures) {
      const image = originalImages.get(texture)!;
      if (!image?.width || !image.height) throw new Error("อ่านภาพในโมเดลไม่สำเร็จ");
      textureBytes += image.width * image.height * 4;
      let pixels = images.get(image);
      if (!pixels) {
        decodedBytes += image.width * image.height * 4;
        if (decodedBytes > 16_000_000 * 4) throw new Error("ภาพในโมเดลรวมกันต้องไม่เกิน 16 ล้านพิกเซล");
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("เบราว์เซอร์นี้ไม่รองรับภาพในโมเดล");
        context.drawImage(image, 0, 0);
        pixels = { data: new Uint8Array(context.getImageData(0, 0, image.width, image.height).data), width: image.width, height: image.height };
        images.set(image, pixels);
      }
      texture.image = pixels;
    }
    // Data images serialize without DOM image URLs and preserve material/UV/scene transforms.
    const scene = result.scene.toJSON();
    for (const image of images.keys()) (image as ImageBitmap).close?.();
    return { scene, parts: [], triangles, textureBytes: Math.ceil(textureBytes * 4 / 3) };
  } finally {
    for (const texture of textures) texture.dispose();
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
  }
}
