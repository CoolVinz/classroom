import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export type AvatarAppearance = {
  skinColor: string;
  hairColor: string;
  shirtColor: string;
  trousersColor: string;
  hairStyle: "none" | "short" | "long" | "ponytail" | "bun" | "spiky" | "bob";
  hatStyle: "none" | "cap" | "beanie" | "wizard";
  glassesStyle: "none" | "round" | "square";
  shoeStyle: "none" | "sneakers" | "boots";
  hatColor: string;
  glassesColor: string;
  shoeColor: string;
};

export const defaultAvatarAppearance: AvatarAppearance = {
  skinColor: "#f3c8a6", hairColor: "#3e2d27", shirtColor: "#4f9b86", trousersColor: "#435875", hairStyle: "short",
  hatStyle: "none", glassesStyle: "none", shoeStyle: "sneakers", hatColor: "#b84d4d", glassesColor: "#302721", shoeColor: "#303a4a",
};

export function createAvatarCharacter(appearance: AvatarAppearance, withWand = false) {
  appearance = { ...defaultAvatarAppearance, ...appearance };
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
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3)); geometry.translate(x, y, z); headParts.push(geometry); return geometry;
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
    if (appearance.hairStyle === "ponytail") addHead(new THREE.CapsuleGeometry(0.075, 0.28, 3, 6), appearance.hairColor, 0, 1.43, -0.24);
    if (appearance.hairStyle === "bun") addHead(new THREE.SphereGeometry(0.12, 8, 6), appearance.hairColor, 0, 1.84, -0.05);
    if (appearance.hairStyle === "spiky") for (const x of [-0.14, 0, 0.14]) addHead(new THREE.ConeGeometry(0.075, 0.2, 6), appearance.hairColor, x, 1.86, 0);
    if (appearance.hairStyle === "bob") for (const x of [-0.2, 0.2]) addHead(new THREE.CapsuleGeometry(0.075, 0.19, 3, 6), appearance.hairColor, x, 1.49, 0);
  }
  if (appearance.hatStyle === "cap") addHead(new THREE.CylinderGeometry(0.24, 0.24, 0.13, 10), appearance.hatColor, 0, 1.83, 0);
  if (appearance.hatStyle === "beanie") addHead(new THREE.SphereGeometry(0.25, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.52), appearance.hatColor, 0, 1.76, 0);
  if (appearance.hatStyle === "wizard") {
    addHead(new THREE.ConeGeometry(0.22, 0.42, 10), appearance.hatColor, 0, 1.98, 0);
    addHead(new THREE.CylinderGeometry(0.28, 0.28, 0.05, 10), appearance.hatColor, 0, 1.79, 0);
  }
  if (appearance.glassesStyle !== "none") {
    for (const x of [-0.085, 0.085]) {
      if (appearance.glassesStyle === "round") addHead(new THREE.TorusGeometry(0.065, 0.012, 4, 10), appearance.glassesColor, x, 1.67, 0.25);
      else {
        const shape = new THREE.Shape();
        shape.moveTo(-0.07,-0.05); shape.lineTo(0.07,-0.05); shape.lineTo(0.07,0.05); shape.lineTo(-0.07,0.05); shape.closePath();
        const hole = new THREE.Path(); hole.moveTo(-0.048,-0.032); hole.lineTo(-0.048,0.032); hole.lineTo(0.048,0.032); hole.lineTo(0.048,-0.032); hole.closePath(); shape.holes.push(hole);
        addHead(new THREE.ShapeGeometry(shape), appearance.glassesColor, x, 1.67, 0.25);
      }
    }
    const bridge = new THREE.CylinderGeometry(0.012,0.012,0.06,5); bridge.rotateZ(Math.PI / 2);
    addHead(bridge, appearance.glassesColor, 0, 1.67, 0.25);
  }
  if (appearance.shoeStyle !== "none") for (const x of [-0.17, 0.17]) {
    const shoe = new THREE.BoxGeometry(0.22, appearance.shoeStyle === "boots" ? 0.2 : 0.12, 0.32);
    addHead(shoe, appearance.shoeColor, x, appearance.shoeStyle === "boots" ? 0.04 : 0.08, 0.055);
  }
  const head = mergeGeometries(headParts, false);
  headParts.forEach((geometry) => geometry.dispose());
  character.add(new THREE.Mesh(head, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 })));
  character.userData.limbs = ["leftLeg", "rightLeg", "leftArm", "rightArm"].map((name) => character.getObjectByName(name) as THREE.Group);
  if (withWand) {
    const wand = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.5, 6), new THREE.MeshStandardMaterial({ color: "#6f452b", roughness: 0.7 }));
    const crystal = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), new THREE.MeshStandardMaterial({ color: "#78f5ff", emissive: "#27d9eb", emissiveIntensity: 1.8 }));
    crystal.position.y = 0.29; wand.add(handle, crystal); wand.position.set(0, -0.38, 0.12); wand.visible = false;
    character.userData.limbs[3].add(wand); character.userData.wand = wand;
  }
  return character;
}

export function animateAvatarCharacter(character: THREE.Group, phase: number, walking: number, airborne: boolean, knocked = false, aiming = false) {
  const swing = Math.sin(phase) * 0.65 * walking;
  const [leftLeg, rightLeg, leftArm, rightArm] = character.userData.limbs as THREE.Group[];
  if (knocked) {
    leftLeg.rotation.x = rightLeg.rotation.x = 0;
    leftArm.rotation.set(-0.45, 0, -0.45); rightArm.rotation.set(-0.25, 0, 0.45);
    return;
  }
  leftLeg.rotation.x = airborne ? -0.25 : swing;
  rightLeg.rotation.x = airborne ? 0.25 : -swing;
  leftArm.rotation.x = airborne ? -0.9 : -swing;
  rightArm.rotation.set(aiming ? -1.1 : airborne ? -0.9 : swing, 0, aiming ? -0.35 : 0);
  const wand = character.userData.wand as THREE.Group | undefined;
  if (wand) wand.visible = aiming;
}

export function disposeAvatarCharacter(character: THREE.Object3D) {
  character.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    materials.forEach((item) => item.dispose());
  });
}
