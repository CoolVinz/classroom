export function syntheticGLTF() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  return {
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0, translation: [10, 20, 30] }, { mesh: 0, translation: [-2, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    buffers: [{ uri: "data:application/octet-stream;base64," + Buffer.from(positions.buffer).toString("base64"), byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
  };
}
export function gltfBytes(value: unknown) { return new TextEncoder().encode(JSON.stringify(value)).buffer; }
export function syntheticGLB() {
  const json = syntheticGLTF();
  const bin = Buffer.from(json.buffers[0]!.uri.split(",")[1]!, "base64");
  delete (json.buffers[0] as { uri?: string }).uri;
  const source = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(source.length / 4) * 4, 32); source.copy(padded);
  const result = Buffer.alloc(12 + 8 + padded.length + 8 + bin.length);
  result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(padded.length, 12); result.writeUInt32LE(0x4e4f534a, 16); padded.copy(result, 20);
  result.writeUInt32LE(bin.length, 20 + padded.length); result.writeUInt32LE(0x004e4942, 24 + padded.length); bin.copy(result, 28 + padded.length);
  return new Uint8Array(result).buffer;
}
