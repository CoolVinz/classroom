import * as THREE from "three";

export type AvatarAppearance = {
  skinColor: string;
  hairColor: string;
  shirtColor: string;
  trousersColor: string;
  hairStyle: "none" | "short" | "long";
};

export const defaultAvatarAppearance: AvatarAppearance = {
  skinColor: "#f3c8a6", hairColor: "#3e2d27", shirtColor: "#4f9b86", trousersColor: "#435875", hairStyle: "short",
};

export function createAvatarCharacter(appearance: AvatarAppearance) {
  const character = new THREE.Group();
  const material = (color: string) => new THREE.MeshStandardMaterial({ color, roughness: 0.78 });
  const add = (geometry: THREE.BufferGeometry, color: string, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, material(color)); mesh.position.set(x, y, z); character.add(mesh); return mesh;
  };
  add(new THREE.CapsuleGeometry(0.31, 0.48, 4, 8), appearance.shirtColor, 0, 1.03, 0);
  add(new THREE.CapsuleGeometry(0.15, 0.34, 3, 6), appearance.trousersColor, -0.17, 0.42, 0);
  add(new THREE.CapsuleGeometry(0.15, 0.34, 3, 6), appearance.trousersColor, 0.17, 0.42, 0);
  add(new THREE.CapsuleGeometry(0.095, 0.43, 3, 6), appearance.shirtColor, -0.39, 1.03, 0);
  add(new THREE.CapsuleGeometry(0.095, 0.43, 3, 6), appearance.shirtColor, 0.39, 1.03, 0);
  add(new THREE.SphereGeometry(0.24, 12, 10), appearance.skinColor, 0, 1.64, 0);
  if (appearance.hairStyle !== "none") {
    add(new THREE.SphereGeometry(0.245, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.53), appearance.hairColor, 0, 1.68, 0);
    if (appearance.hairStyle === "long") {
      add(new THREE.CapsuleGeometry(0.07, 0.35, 3, 6), appearance.hairColor, -0.2, 1.43, 0);
      add(new THREE.CapsuleGeometry(0.07, 0.35, 3, 6), appearance.hairColor, 0.2, 1.43, 0);
    }
  }
  return character;
}

export function disposeAvatarCharacter(character: THREE.Object3D) {
  character.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    materials.forEach((item) => item.dispose());
  });
}
