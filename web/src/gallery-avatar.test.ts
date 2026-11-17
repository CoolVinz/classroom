import { describe, expect, test } from "bun:test";
import { animateAvatarCharacter, createAvatarCharacter, defaultAvatarAppearance, disposeAvatarCharacter } from "./gallery-avatar";

describe("gallery avatar characters", () => {
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
