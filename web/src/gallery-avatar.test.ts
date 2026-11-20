import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { animateAvatarCharacter, avatarNameLabelY, createAvatarCharacter, defaultAvatarAppearance, disposeAvatarCharacter } from "./gallery-avatar";

describe("gallery avatar characters", () => {
  test("shoes share their leg mesh, color, and animated transform without extra draw calls", () => {
    for (const shoeStyle of ["none", "sneakers", "boots"] as const) {
      const character = createAvatarCharacter({ ...defaultAvatarAppearance, shoeStyle });
      const tint = new THREE.Color(defaultAvatarAppearance.shoeColor);
      let meshes = 0;
      character.traverse((object) => { if (object instanceof THREE.Mesh) meshes++; });
      expect(meshes).toBe(5);
      for (const phase of [Math.PI / 2, -Math.PI / 2]) for (const [airborne, knocked] of [[false, false], [true, false], [false, true], [false, false]]) {
        animateAvatarCharacter(character, phase, 1, airborne, knocked);
        character.rotation.z = knocked ? -Math.PI / 2 : 0;
        character.position.y = airborne ? 1 : 0;
        character.updateMatrixWorld(true);
        for (const name of ["leftLeg", "rightLeg"]) {
          const leg = character.getObjectByName(name)!;
          const mesh = leg.children[0] as THREE.Mesh;
          const positions = mesh.geometry.getAttribute("position"), colors = mesh.geometry.getAttribute("color");
          const center = new THREE.Vector3(); let count = 0;
          for (let i = 0; i < colors.count; i++) if (Math.abs(colors.getX(i) - tint.r) < 1e-6 && Math.abs(colors.getY(i) - tint.g) < 1e-6 && Math.abs(colors.getZ(i) - tint.b) < 1e-6) {
            center.add(new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld)); count++;
          }
          if (shoeStyle === "none") { expect(count).toBe(0); continue; }
          expect(count).toBe(24);
          center.divideScalar(count);
          const ankleY = shoeStyle === "boots" ? -0.435 : -0.552;
          const expected = new THREE.Vector3(0, (-0.67 - 0.622 + ankleY) / 3, (0.052 + 0.05 - 0.009) / 3).applyMatrix4(leg.matrixWorld);
          expect(center.distanceTo(expected)).toBeLessThan(1e-6);
        }
      }
      disposeAvatarCharacter(character);
    }
  });
  test("every supported appearance fits five draw calls and the existing triangle budget", () => {
    const hairstyles = ["none", "short", "long", "ponytail", "bun", "spiky", "bob"] as const;
    const hats = ["none", "cap", "beanie", "wizard"] as const;
    const glasses = ["none", "round", "square"] as const;
    const shoes = ["none", "sneakers", "boots"] as const;
    for (const hairStyle of hairstyles) for (const hatStyle of hats) for (const glassesStyle of glasses) for (const shoeStyle of shoes) {
      const character = createAvatarCharacter({ ...defaultAvatarAppearance, hairStyle, hatStyle, glassesStyle, shoeStyle });
      let meshes = 0, triangles = 0;
      character.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        meshes++;
        triangles += object.geometry.index!.count / 3;
        expect(object.material.flatShading).toBe(true);
      });
      expect(meshes).toBe(5);
      const isDefault = hairStyle === "short" && hatStyle === "none" && glassesStyle === "none" && shoeStyle === "sneakers";
      expect(triangles).toBeLessThanOrEqual(isDefault ? 1044 : 1522);
      const bounds = new THREE.Box3().setFromObject(character);
      expect(Math.abs(bounds.min.y)).toBeLessThan(0.01);
      expect(bounds.max.y).toBeLessThan(avatarNameLabelY - 0.25);
      disposeAvatarCharacter(character);
    }
  });
  test("keeps the selected colors on the faceted model", () => {
    const appearance = {
      skinColor: "#e8b37c", hairColor: "#1c3549", shirtColor: "#647853", trousersColor: "#573d55",
      hatColor: "#a25936", glassesColor: "#ad8d5d", shoeColor: "#3f4367",
      hairStyle: "ponytail", hatStyle: "wizard", glassesStyle: "square", shoeStyle: "boots",
    } as const;
    const character = createAvatarCharacter(appearance);
    const colors = new Set<string>();
    character.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const vertices = object.geometry.getAttribute("color");
      const color = new THREE.Color();
      for (let i = 0; i < vertices.count; i++) colors.add("#" + color.fromBufferAttribute(vertices, i).getHexString());
    });
    for (const [key, value] of Object.entries(appearance)) if (key.endsWith("Color")) expect(colors.has(value)).toBe(true);
    disposeAvatarCharacter(character);
  });
  test("walking swings opposite limbs, jumping poses them, and cleanup releases resources", () => {
    const character = createAvatarCharacter(defaultAvatarAppearance, true);
    animateAvatarCharacter(character, Math.PI / 2, 1, false);
    expect(character.getObjectByName("leftLeg")!.rotation.x).toBeCloseTo(0.65);
    expect(character.getObjectByName("rightLeg")!.rotation.x).toBeCloseTo(-0.65);
    animateAvatarCharacter(character, 0, 0, true);
    expect(character.getObjectByName("leftArm")!.rotation.x).toBe(-0.9);
    animateAvatarCharacter(character, 0, 0, false);
    expect(character.getObjectByName("leftLeg")!.rotation.x).toBe(0);
    animateAvatarCharacter(character, 0, 0, false, true);
    expect(character.getObjectByName("rightArm")!.rotation.z).toBeCloseTo(0.45);
    animateAvatarCharacter(character, 0, 0, false, false, true);
    expect(character.userData.wand.visible).toBe(true);
    animateAvatarCharacter(character, 0, 0, false);
    expect(character.userData.wand.visible).toBe(false);
    let geometries = 0, materials = 0;
    character.traverse((object: any) => {
      object.geometry?.addEventListener("dispose", () => geometries++);
      object.material?.addEventListener("dispose", () => materials++);
    });
    disposeAvatarCharacter(character);
    expect(geometries).toBe(7); expect(materials).toBe(7);
  });
});
