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
export const avatarNameLabelY = 2.49;

// Raising the front edge of the lower hair ring keeps the eyes clear while covering the back.
type Section = [y: number, width: number, depth: number, forward?: number, frontLift?: number];
const bevel = [[1, 0.65], [0.65, 1], [-0.65, 1], [-1, 0.65], [-1, -0.65], [-0.65, -1], [0.65, -1], [1, -0.65]];

function facetedShape(...sections: Section[]) {
  const positions: number[] = [], indices: number[] = [];
  const sides = bevel.length;
  for (const [y, width, depth, forward = 0, frontLift = 0] of sections) {
    for (const [x, z] of bevel) positions.push(x * width, y + Math.max(0, z) * frontLift, forward + z * depth);
  }
  for (let layer = 0; layer < sections.length - 1; layer++) {
    const offset = layer * sides;
    for (let i = 0; i < sides; i++) {
      const a = offset + i, b = offset + (i + 1) % sides;
      indices.push(a, a + sides, b + sides, a, b + sides, b);
    }
  }
  const top = (sections.length - 1) * sides;
  for (let i = 1; i < sides - 1; i++) indices.push(0, i, i + 1, top, top + i + 1, top + i);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function avatarParts() {
  const parts: THREE.BufferGeometry[] = [];
  return {
    add(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation, x = 0, y = 0, z = 0) {
      const tint = new THREE.Color(color);
      const colors = new Float32Array(geometry.getAttribute("position").count * 3);
      for (let i = 0; i < colors.length; i += 3) tint.toArray(colors, i);
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geometry.deleteAttribute("uv");
      parts.push(geometry.translate(x, y, z));
    },
    mesh() {
      const geometry = mergeGeometries(parts, false)!;
      parts.forEach((part) => part.dispose());
      return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.84 }));
    },
  };
}

function coloredShade(color: string, factor: number) {
  return new THREE.Color(color).multiplyScalar(factor);
}

function createLeg(appearance: AvatarAppearance) {
  const leg = avatarParts();
  const { trousersColor, shoeColor, shoeStyle, skinColor } = appearance;
  leg.add(facetedShape(
    [-0.61, 0.085, 0.099], [-0.37, 0.113, 0.115], [0.025, 0.143, 0.139],
  ), trousersColor);
  if (shoeStyle === "none") {
    leg.add(facetedShape([-0.695, 0.081, 0.117, 0.043], [-0.657, 0.095, 0.139, 0.05], [-0.586, 0.07, 0.086, -0.005]), skinColor);
  } else {
    const boot = shoeStyle === "boots";
    const sole = boot ? coloredShade(shoeColor, 0.52) : new THREE.Color(shoeColor).lerp(new THREE.Color("#e6e3d9"), 0.72);
    leg.add(facetedShape([-0.698, 0.099, 0.152, 0.053], [-0.67, 0.114, 0.165, 0.052]), sole);
    leg.add(facetedShape(
      [-0.67, 0.113, 0.163, 0.052], [-0.622, 0.108, 0.16, 0.05],
      boot ? [-0.435, 0.114, 0.117, -0.009] : [-0.552, 0.096, 0.101, -0.009],
    ), shoeColor);
    if (boot) {
      leg.add(facetedShape([-0.466, 0.116, 0.129, -0.009], [-0.423, 0.118, 0.13, -0.009]), coloredShade(shoeColor, 1.2));
    } else {
      for (const z of [0.116, 0.145]) leg.add(new THREE.PlaneGeometry(0.105, 0.011).rotateX(-1.035), sole, 0, -0.563 - (z - 0.116) * 0.59, z);
    }
  }
  return leg.mesh();
}

function createArm(appearance: AvatarAppearance, side: number) {
  const arm = avatarParts();
  arm.add(facetedShape(
    [-0.5, 0.061, 0.069, 0.015], [-0.18, 0.088, 0.091],
  ), appearance.skinColor, side * 0.017);
  arm.add(facetedShape(
    [-0.22, 0.088, 0.091], [0.026, 0.098, 0.104],
  ), appearance.shirtColor);
  arm.add(facetedShape([-0.231, 0.088, 0.092], [-0.198, 0.091, 0.095]), coloredShade(appearance.shirtColor, 0.76));
  arm.add(facetedShape(
    [-0.575, 0.041, 0.048, 0.022], [-0.48, 0.068, 0.063, 0.018],
  ), appearance.skinColor, side * 0.016);
  return arm.mesh();
}

function createBody(appearance: AvatarAppearance) {
  const body = avatarParts(), { shirtColor, skinColor, hairColor, hairStyle, hatColor, hatStyle, glassesStyle, glassesColor } = appearance;
  const collar = coloredShade(shirtColor, 0.65);
  body.add(facetedShape([0.69, 0.255, 0.158], [1.22, 0.307, 0.196], [1.33, 0.281, 0.171], [1.39, 0.13, 0.108]), shirtColor);
  body.add(facetedShape([0.695, 0.26, 0.163], [0.737, 0.266, 0.167]), coloredShade(shirtColor, 0.86));
  body.add(new THREE.CylinderGeometry(0.105, 0.119, 0.135, 8), skinColor, 0, 1.416);
  for (const side of [-1, 1]) body.add(new THREE.BoxGeometry(0.112, 0.035, 0.023).rotateZ(side * 0.46), collar, side * 0.052, 1.319, 0.174);
  body.add(facetedShape([1.045, 0.051, 0.016], [1.109, 0.059, 0.016]), coloredShade(shirtColor, 0.79), -0.132, 0, 0.184);
  body.add(new THREE.BoxGeometry(0.121, 0.016, 0.017), collar, -0.132, 1.109, 0.196);
  body.add(new THREE.BoxGeometry(0.142, 0.026, 0.019), coloredShade(shirtColor, 0.8), 0, 1.343, -0.146);
  body.add(facetedShape(
    [1.427, 0.126, 0.103, 0.022], [1.504, 0.202, 0.171, 0.014],
    [1.613, 0.243, 0.209, 0.005], [1.745, 0.234, 0.205],
    [1.871, 0.105, 0.091],
  ), skinColor);
  const ink = "#302423";
  const lip = new THREE.Color(skinColor).lerp(new THREE.Color("#632c31"), 0.76);
  for (const side of [-1, 1]) {
    body.add(new THREE.SphereGeometry(1, 5, 3).scale(0.04, 0.055, 0.035), skinColor, side * 0.224, 1.607, 0.016);
    body.add(new THREE.SphereGeometry(1, 6, 3).scale(0.042, 0.035, 0.019), "#fff5e8", side * 0.085, 1.665, 0.212);
    body.add(new THREE.SphereGeometry(1, 5, 3).scale(0.02, 0.027, 0.014), ink, side * 0.085, 1.664, 0.229);
    body.add(new THREE.BoxGeometry(0.057, 0.014, 0.014).rotateZ(-side * 0.12), ink, side * 0.092, 1.722, 0.209);
    body.add(new THREE.BoxGeometry(0.036, 0.011, 0.012).rotateZ(side * 0.26), lip, side * 0.016, 1.547, 0.203);
  }
  body.add(new THREE.SphereGeometry(1, 6, 3).scale(0.036, 0.035, 0.046), skinColor, 0, 1.596, 0.216);
  if (hairStyle !== "none") {
    const highlight = coloredShade(hairColor, 1.33);
    body.add(facetedShape([1.54, 0.232, 0.203, -0.02, 0.226], [1.784, 0.246, 0.223, -0.005], [1.867, 0.187, 0.176, -0.009], [1.905, 0.088, 0.088, -0.015]), hairColor);
    body.add(facetedShape([1.741, 0.041, 0.037, 0.013], [1.804, 0.095, 0.046], [1.861, 0.081, 0.035, -0.025]), highlight, -0.063, 0, 0.184);
    if (hairStyle === "long" || hairStyle === "bob") {
      const bottom = hairStyle === "long" ? 1.25 : 1.45;
      body.add(facetedShape([bottom, 0.158, 0.043, -0.142], [bottom + 0.1, 0.222, 0.073, -0.174], [1.762, 0.213, 0.067, -0.144]), hairColor);
      for (const side of [-1, 1]) {
        body.add(facetedShape([bottom + 0.01, 0.036, 0.065, -0.046], [bottom + 0.13, 0.061, 0.081, -0.025], [1.766, 0.052, 0.083, -0.01]), side === -1 ? highlight : hairColor, side * 0.186);
      }
    } else if (hairStyle === "ponytail") {
      body.add(facetedShape([1.29, 0.03, 0.04, -0.32], [1.44, 0.081, 0.059, -0.312], [1.61, 0.076, 0.063, -0.279], [1.73, 0.047, 0.036, -0.217]), highlight);
    } else if (hairStyle === "bun") {
      const underHat = hatStyle !== "none";
      body.add(new THREE.SphereGeometry(1, 8, 5).scale(0.101, 0.103, 0.113), highlight, 0, underHat ? 1.741 : 1.851, underHat ? -0.244 : -0.149);
    } else if (hairStyle === "spiky" && hatStyle === "none") {
      for (const side of [-1, 0, 1]) {
        body.add(new THREE.ConeGeometry(0.075, side === 0 ? 0.17 : 0.135, 5).rotateZ(-side * 0.29), side === 0 ? highlight : hairColor, side * 0.121, 1.902 - Math.abs(side) * 0.021, -0.014);
      }
    }
  }
  const hatBand = coloredShade(hatColor, 0.65);
  if (hatStyle === "cap") {
    body.add(facetedShape([1.816, 0.249, 0.235], [1.899, 0.241, 0.223], [1.965, 0.187, 0.188, -0.021], [1.992, 0.093, 0.097, -0.023]), hatColor);
    body.add(facetedShape([1.8, 0.166, 0.148, 0.205], [1.828, 0.174, 0.156, 0.196]), hatBand);
  } else if (hatStyle === "beanie") {
    body.add(facetedShape([1.794, 0.249, 0.229], [1.931, 0.208, 0.199], [2.025, 0.115, 0.106, -0.025], [2.042, 0.054, 0.044, -0.031]), hatColor);
    body.add(facetedShape([1.785, 0.252, 0.234], [1.85, 0.247, 0.23]), hatBand);
  } else if (hatStyle === "wizard") {
    body.add(facetedShape([1.829, 0.332, 0.29], [1.866, 0.318, 0.282]), hatColor);
    body.add(facetedShape([1.86, 0.224, 0.218], [1.966, 0.152, 0.158, -0.032], [2.08, 0.074, 0.076, -0.082], [2.167, 0.013, 0.014, -0.16]), hatColor);
    body.add(facetedShape([1.875, 0.222, 0.218, -0.006], [1.924, 0.196, 0.194, -0.02]), hatBand);
  }
  if (glassesStyle !== "none") {
    for (const x of [-0.087, 0.087]) {
      if (glassesStyle === "round") body.add(new THREE.TorusGeometry(0.056, 0.009, 3, 10), glassesColor, x, 1.665, 0.252);
      else {
        for (const side of [-1, 1]) {
          body.add(new THREE.BoxGeometry(0.11, 0.012, 0.013), glassesColor, x, 1.665 + side * 0.045, 0.252);
          body.add(new THREE.BoxGeometry(0.012, 0.082, 0.013), glassesColor, x + side * 0.05, 1.665, 0.252);
        }
      }
      body.add(new THREE.BoxGeometry(0.012, 0.013, 0.154).rotateY(Math.sign(x) * 0.54), glassesColor, x * 2.04, 1.68, 0.181);
    }
    body.add(new THREE.BoxGeometry(0.067, 0.012, 0.015), glassesColor, 0, 1.676, 0.252);
  }
  return body.mesh();
}

export function createAvatarCharacter(appearance: AvatarAppearance, withWand = false) {
  appearance = { ...defaultAvatarAppearance, ...appearance };
  const character = new THREE.Group();
  const limb = (name: string, mesh: THREE.Mesh, x: number, y: number) => {
    const pivot = new THREE.Group();
    pivot.name = name;
    pivot.position.set(x, y, 0);
    pivot.add(mesh);
    character.add(pivot);
    return pivot;
  };
  character.userData.limbs = [
    limb("leftLeg", createLeg(appearance), -0.17, 0.7),
    limb("rightLeg", createLeg(appearance), 0.17, 0.7),
    limb("leftArm", createArm(appearance, -1), -0.39, 1.28),
    limb("rightArm", createArm(appearance, 1), 0.39, 1.28),
  ];
  character.add(createBody(appearance));
  if (withWand) {
    const wand = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.5, 6), new THREE.MeshStandardMaterial({ color: "#6f452b", roughness: 0.7 }));
    const crystal = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), new THREE.MeshStandardMaterial({ color: "#78f5ff", emissive: "#27d9eb", emissiveIntensity: 1.8 }));
    crystal.position.y = 0.29; wand.add(handle, crystal); wand.position.set(0, -0.38, 0.12); wand.visible = false;
    character.userData.limbs[3].add(wand); character.userData.wand = wand;
  }
  return character;
}

export function animateAvatarCharacter(character: THREE.Group, phase: number, walking: number, airborne: boolean, knocked = false, aiming = false, driving = false) {
  const swing = Math.sin(phase) * 0.65 * walking;
  const [leftLeg, rightLeg, leftArm, rightArm] = character.userData.limbs as THREE.Group[];
  if (knocked) {
    leftLeg.rotation.x = rightLeg.rotation.x = 0;
    leftArm.rotation.set(-0.45, 0, -0.45); rightArm.rotation.set(-0.25, 0, 0.45);
    return;
  }
  leftLeg.rotation.x = driving ? -1.15 : airborne ? -0.25 : swing;
  rightLeg.rotation.x = driving ? -1.15 : airborne ? 0.25 : -swing;
  leftArm.rotation.x = airborne || driving ? -0.9 : -swing;
  rightArm.rotation.set(aiming ? -1.1 : airborne || driving ? -0.9 : swing, 0, aiming ? -0.35 : 0);
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
