import * as THREE from "three";

export function parseDiffuseMaterials(text = "") {
  const materials = new Map<string, THREE.Color>();
  let current = "";
  for (const line of text.split(/\r?\n/)) {
    const [key, ...values] = line.replace(/#.*/, "").trim().split(/\s+/);
    if (key === "newmtl") current = values.join(" ");
    else if (key === "Kd" && current && values.length >= 3) {
      const rgb = values.slice(0, 3).map(Number);
      if (rgb.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
        materials.set(current, new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace));
      }
    }
  }
  return materials;
}
