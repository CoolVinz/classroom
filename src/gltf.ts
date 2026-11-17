const supported = new Set(["KHR_materials_unlit", "KHR_texture_transform", "KHR_materials_clearcoat", "KHR_materials_ior", "KHR_materials_specular", "KHR_materials_transmission", "KHR_materials_volume", "KHR_materials_sheen", "KHR_materials_iridescence", "KHR_materials_anisotropy", "KHR_materials_emissive_strength", "KHR_mesh_quantization"]);
const fail = () => { throw new Error("ไฟล์ glTF ไม่ถูกต้อง ต้องใช้ glTF 2.0 ที่ฝังข้อมูลทั้งหมดในไฟล์เดียว"); };
export function embeddedBytes(uri: unknown): Uint8Array {
  if (typeof uri !== "string" || !/^data:(application\/(octet-stream|gltf-buffer)|image\/(png|jpeg));base64,[A-Za-z0-9+/]*={0,2}$/.test(uri)) return fail();
  try { return Uint8Array.from(atob(uri.slice(uri.indexOf(",") + 1)), (ch) => ch.charCodeAt(0)); } catch { return fail(); }
}
export function inspectGLTF(bytes: ArrayBuffer, binary: boolean) {
  let json: any, bin: Uint8Array | undefined;
  if (binary) {
    const view = new DataView(bytes);
    if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.byteLength) return fail();
    let offset = 12;
    while (offset < bytes.byteLength) {
      if (offset + 8 > bytes.byteLength) return fail();
      const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
      if (length % 4 || offset + 8 + length > bytes.byteLength) return fail();
      const chunk = new Uint8Array(bytes, offset + 8, length);
      if (offset === 12) {
        if (type !== 0x4e4f534a) return fail();
        json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(chunk));
      } else if (type === 0x004e4942 && !bin) bin = chunk;
      else return fail();
      offset += 8 + length;
    }
  } else json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!json || json.asset?.version !== "2.0" || (json.asset.minVersion && json.asset.minVersion !== "2.0")) return fail();
  for (const name of json.extensionsRequired ?? []) if (!supported.has(name)) throw new Error("ไม่รองรับส่วนขยาย glTF: " + name);
  const scan = (value: any, depth = 0) => {
    if (depth > 100) return fail();
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "uri" && (typeof child !== "string" || !child.startsWith("data:"))) throw new Error("glTF ต้องฝังข้อมูลและภาพในไฟล์เดียว ไม่อนุญาต URL หรือไฟล์ภายนอก");
      if (key === "extensions" && child && typeof child === "object" && Object.keys(child).some((name) => /draco|meshopt|basisu/i.test(name))) throw new Error("ยังไม่รองรับโมเดลหรือภาพบีบอัด Draco, Meshopt หรือ KTX2");
      scan(child, depth + 1);
    }
  };
  scan(json);
  const buffers: Uint8Array[] = (json.buffers ?? []).map((buffer: any, index: number) => {
    const data = buffer.uri !== undefined ? embeddedBytes(buffer.uri) : index === 0 ? bin : undefined;
    if (!data || !Number.isSafeInteger(buffer.byteLength) || buffer.byteLength < 0 || buffer.byteLength > data.byteLength) return fail();
    return data.subarray(0, buffer.byteLength);
  });
  const views: Uint8Array[] = (json.bufferViews ?? []).map((view: any) => {
    const buffer = buffers[view.buffer], start = view.byteOffset ?? 0, length = view.byteLength;
    if (!buffer || !Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start + length > buffer.byteLength) return fail();
    return buffer.subarray(start, start + length);
  });
  for (const accessor of json.accessors ?? []) {
    if (!Number.isSafeInteger(accessor.count) || accessor.count < 0 || accessor.count > 1_500_000) return fail();
    const components = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 } as Record<string, number>)[accessor.type];
    const size = ({ 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 } as Record<number, number>)[accessor.componentType];
    if (!components || !size) return fail();
    if (accessor.bufferView !== undefined) {
      const view = views[accessor.bufferView], offset = accessor.byteOffset ?? 0;
      const stride = json.bufferViews[accessor.bufferView]?.byteStride ?? components * size;
      if (!view || !Number.isSafeInteger(offset) || offset < 0 || stride < components * size || offset + Math.max(0, accessor.count - 1) * stride + components * size > view.byteLength) return fail();
    }
  }
  for (const mesh of json.meshes ?? []) {
    if (!Array.isArray(mesh.primitives) || !mesh.primitives.length) return fail();
    for (const primitive of mesh.primitives) {
      if (!json.accessors?.[primitive.attributes?.POSITION] || (primitive.indices !== undefined && !json.accessors?.[primitive.indices])) return fail();
    }
  }
  const visiting = new Set<number>(), visited = new Set<number>();
  const visitNode = (index: number, depth: number) => {
    if (!Number.isInteger(index) || !json.nodes?.[index] || visiting.has(index) || depth > 100) return fail();
    if (visited.has(index)) return;
    visiting.add(index);
    const node = json.nodes[index];
    if (node.mesh !== undefined && !json.meshes?.[node.mesh]) return fail();
    for (const child of node.children ?? []) visitNode(child, depth + 1);
    visiting.delete(index); visited.add(index);
  };
  for (const scene of json.scenes ?? []) for (const index of scene.nodes ?? []) visitNode(index, 0);
  const images: Uint8Array[] = (json.images ?? []).map((image: any) => {
    if (image.mimeType && image.mimeType !== "image/png" && image.mimeType !== "image/jpeg") return fail();
    const data = image.uri !== undefined ? embeddedBytes(image.uri) : views[image.bufferView];
    if (!data || !(data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71 || data[0] === 255 && data[1] === 216 && data[2] === 255)) return fail();
    return data;
  });
  if (!Array.isArray(json.scenes) || !json.scenes.length || !json.scenes[json.scene ?? 0] || !Array.isArray(json.meshes) || !json.meshes.length) return fail();
  return { json, images };
}
