import { describe, expect, test } from "bun:test";
import { animateAvatarCharacter, createAvatarCharacter, defaultAvatarAppearance, disposeAvatarCharacter } from "./gallery-avatar";

describe("gallery avatar characters", () => {
  test("renders each supported hair style and releases its geometry", () => {
    for (const hairStyle of ["none", "short", "long"] as const) {
      const character = createAvatarCharacter({ ...defaultAvatarAppearance, hairStyle });
      expect(character.children.length).toBe(hairStyle === "long" ? 9 : hairStyle === "short" ? 7 : 6);
      disposeAvatarCharacter(character);
    }
  });
  test("walking swings opposite limbs, jumping poses them, and cleanup releases resources", () => {
    const character = createAvatarCharacter(defaultAvatarAppearance);
    animateAvatarCharacter(character, Math.PI / 2, 1, false);
    expect(character.getObjectByName("leftLeg")!.rotation.x).toBeCloseTo(0.65);
    expect(character.getObjectByName("rightLeg")!.rotation.x).toBeCloseTo(-0.65);
    animateAvatarCharacter(character, 0, 0, true);
    expect(character.getObjectByName("leftArm")!.rotation.x).toBe(-0.9);
    animateAvatarCharacter(character, 0, 0, false);
    expect(character.getObjectByName("leftLeg")!.rotation.x).toBe(0);
    let geometries = 0, materials = 0;
    character.traverse((object: any) => {
      object.geometry?.addEventListener("dispose", () => geometries++);
      object.material?.addEventListener("dispose", () => materials++);
    });
    disposeAvatarCharacter(character);
    expect(geometries).toBe(7); expect(materials).toBe(7);
  });
});
