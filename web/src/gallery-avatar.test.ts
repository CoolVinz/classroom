import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { animateAvatarCharacter, createAvatarCharacter, defaultAvatarAppearance, disposeAvatarCharacter } from "./gallery-avatar";

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
          const expected = new THREE.Vector3(0, (shoeStyle === "boots" ? 0.04 : 0.08) - 0.7, 0.055).applyMatrix4(leg.matrixWorld);
          expect(center.distanceTo(expected)).toBeLessThan(1e-6);
        }
      }
      disposeAvatarCharacter(character);
    }
  });
  test("renders each supported hair style and releases its geometry", () => {
    const hairstyles = ["none", "short", "long", "ponytail", "bun", "spiky", "bob"] as const;
    const hats = ["none", "cap", "beanie", "wizard"] as const;
    const glasses = ["none", "round", "square"] as const;
    const shoes = ["none", "sneakers", "boots"] as const;
    for (const [index, hairStyle] of hairstyles.entries()) {
      for (const hatStyle of hats) {
        const character = createAvatarCharacter({ ...defaultAvatarAppearance, hairStyle, hatStyle, glassesStyle: glasses[index % glasses.length], shoeStyle: shoes[index % shoes.length] });
        expect(character.children.length).toBe(5);
        disposeAvatarCharacter(character);
      }
    }
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
