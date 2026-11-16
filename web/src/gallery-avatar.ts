import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

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
  const limb = (name: string, geometry: THREE.BufferGeometry, color: string, x: number, y: number, length: number) => {
    const pivot = new THREE.Group(); pivot.name = name; pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.78 })); mesh.position.y = -length; pivot.add(mesh); character.add(pivot);
  };
  limb("leftLeg", new THREE.CapsuleGeometry(0.15, 0.34, 3, 6), appearance.trousersColor, -0.17, 0.7, 0.28);
  limb("rightLeg", new THREE.CapsuleGeometry(0.15, 0.34, 3, 6), appearance.trousersColor, 0.17, 0.7, 0.28);
  limb("leftArm", new THREE.CapsuleGeometry(0.095, 0.43, 3, 6), appearance.shirtColor, -0.39, 1.28, 0.25);
  limb("rightArm", new THREE.CapsuleGeometry(0.095, 0.43, 3, 6), appearance.shirtColor, 0.39, 1.28, 0.25);
  const headParts: THREE.BufferGeometry[] = [];
  const addHead = (geometry: THREE.BufferGeometry, color: string, x: number, y: number, z: number) => {
    const tint = new THREE.Color(color), colors = new Float32Array(geometry.getAttribute("position").count * 3);
    for (let i = 0; i < colors.length; i += 3) { colors[i] = tint.r; colors[i + 1] = tint.g; colors[i + 2] = tint.b; }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3)); geometry.translate(x, y, z); headParts.push(geometry);
  };
  addHead(new THREE.CapsuleGeometry(0.31, 0.48, 4, 8), appearance.shirtColor, 0, 1.03, 0);
  addHead(new THREE.SphereGeometry(0.24, 12, 10), appearance.skinColor, 0, 1.64, 0);
  for (const x of [-0.085, 0.085]) addHead(new THREE.SphereGeometry(0.035, 6, 5), "#302721", x, 1.67, 0.219);
  addHead(new THREE.SphereGeometry(0.038, 6, 5), appearance.skinColor, 0, 1.61, 0.235);
  if (appearance.hairStyle !== "none") {
    addHead(new THREE.SphereGeometry(0.245, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.53), appearance.hairColor, 0, 1.68, 0);
    if (appearance.hairStyle === "long") {
      addHead(new THREE.CapsuleGeometry(0.07, 0.35, 3, 6), appearance.hairColor, -0.2, 1.43, 0);
      addHead(new THREE.CapsuleGeometry(0.07, 0.35, 3, 6), appearance.hairColor, 0.2, 1.43, 0);
    }
  }
  const head = mergeGeometries(headParts, false);
  headParts.forEach((geometry) => geometry.dispose());
  character.add(new THREE.Mesh(head, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 })));
  character.userData.limbs = ["leftLeg", "rightLeg", "leftArm", "rightArm"].map((name) => character.getObjectByName(name) as THREE.Group);
  return character;
}

export function animateAvatarCharacter(character: THREE.Group, phase: number, walking: number, airborne: boolean) {
  const swing = Math.sin(phase) * 0.65 * walking;
  const [leftLeg, rightLeg, leftArm, rightArm] = character.userData.limbs as THREE.Group[];
  leftLeg.rotation.x = airborne ? -0.25 : swing;
  rightLeg.rotation.x = airborne ? 0.25 : -swing;
  leftArm.rotation.x = airborne ? -0.9 : -swing;
  rightArm.rotation.x = airborne ? -0.9 : swing;
}

export function disposeAvatarCharacter(character: THREE.Object3D) {
  character.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    materials.forEach((item) => item.dispose());
  });
}
