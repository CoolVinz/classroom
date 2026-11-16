import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { parseDiffuseMaterials } from "./obj-materials";
import type { ModelPart } from "./model-view";

export function parseOBJModel(buffer: ArrayBuffer, materialText?: string) {
  const diffuse = parseDiffuseMaterials(materialText);
  const object = new OBJLoader().parse(new TextDecoder().decode(buffer));
  const parts: ModelPart[] = [];
  let triangles = 0;
  object.updateMatrixWorld(true);
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const geometry = child.geometry.clone(); geometry.applyMatrix4(child.matrixWorld);
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
    const sourceIndex = geometry.getIndex();
    triangles += (sourceIndex?.count ?? geometry.getAttribute("position").count) / 3;
    if (triangles > 500_000) { geometry.dispose(); throw new Error("โมเดลใหญ่เกินไปสำหรับการแสดงตัวอย่าง (สูงสุด 500,000 รูปสามเหลี่ยม)"); }
    const expanded = sourceIndex ? geometry.toNonIndexed() : geometry;
    const positions = expanded.getAttribute("position").array as Float32Array;
    const normals = expanded.getAttribute("normal").array as Float32Array;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    const groups = expanded.groups.length ? expanded.groups : [{ start: 0, count: positions.length / 3, materialIndex: 0 }];
    for (const group of groups) {
      const start = group.start * 3, end = (group.start + group.count) * 3;
      if (end <= start || end > positions.length) continue;
      const name = materials[group.materialIndex]?.name ?? materials[0]?.name ?? "";
      const color = diffuse.get(name);
      const part: ModelPart = { positions: positions.slice(start, end), normals: normals.slice(start, end) };
      if (color) {
        const colors = new Float32Array(end - start);
        for (let i = 0; i < colors.length; i += 3) { colors[i] = color.r; colors[i + 1] = color.g; colors[i + 2] = color.b; }
        part.colors = colors;
      }
      parts.push(part);
    }
    if (expanded !== geometry) expanded.dispose();
    geometry.dispose();
  });
  return { parts, triangles };
}
