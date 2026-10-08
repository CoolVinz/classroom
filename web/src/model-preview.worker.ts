import * as THREE from "three";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";

type Part = { positions: Float32Array; normals: Float32Array; indices?: Uint32Array };
const workerContext = self as unknown as {
  onmessage: ((event: MessageEvent<{ extension: "stl" | "obj"; buffer: ArrayBuffer }>) => void) | null;
  postMessage: (message: unknown, options?: { transfer: Transferable[] }) => void;
};
workerContext.onmessage = (event) => {
  try {
    const { extension, buffer } = event.data;
    const parts: Part[] = [];
    let triangles = 0;
    if (extension === "stl") {
      if (buffer.byteLength >= 84) {
        const count = new DataView(buffer).getUint32(80, true);
        if (84 + count * 50 === buffer.byteLength && count > 500_000) throw new Error("โมเดลใหญ่เกินไปสำหรับการแสดงตัวอย่าง (สูงสุด 500,000 รูปสามเหลี่ยม)");
      }
      const geometry = new STLLoader().parse(buffer);
      if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
      triangles = geometry.getAttribute("position").count / 3;
      if (triangles > 500_000) throw new Error("โมเดลใหญ่เกินไปสำหรับการแสดงตัวอย่าง (สูงสุด 500,000 รูปสามเหลี่ยม)");
      parts.push({ positions: new Float32Array(geometry.getAttribute("position").array), normals: new Float32Array(geometry.getAttribute("normal").array) });
      geometry.dispose();
    } else {
      const object = new OBJLoader().parse(new TextDecoder().decode(buffer));
      object.updateMatrixWorld(true);
      object.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const geometry = child.geometry.clone();
        geometry.applyMatrix4(child.matrixWorld);
        if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
        const index = geometry.getIndex();
        triangles += (index?.count ?? geometry.getAttribute("position").count) / 3;
        if (triangles > 500_000) { geometry.dispose(); throw new Error("โมเดลใหญ่เกินไปสำหรับการแสดงตัวอย่าง (สูงสุด 500,000 รูปสามเหลี่ยม)"); }
        parts.push({
          positions: new Float32Array(geometry.getAttribute("position").array),
          normals: new Float32Array(geometry.getAttribute("normal").array),
          ...(index ? { indices: new Uint32Array(index.array) } : {}),
        });
        geometry.dispose();
      });
    }
    if (!parts.length || triangles > 500_000) throw new Error("โมเดลใหญ่เกินไปสำหรับการแสดงตัวอย่าง (สูงสุด 500,000 รูปสามเหลี่ยม)");
    const transfer = parts.flatMap((part) => [part.positions.buffer, part.normals.buffer, ...(part.indices ? [part.indices.buffer] : [])]);
    workerContext.postMessage({ parts, triangles }, { transfer });
  } catch (error) {
    workerContext.postMessage({ error: error instanceof Error ? error.message : "อ่านโมเดลไม่สำเร็จ" });
  }
};
