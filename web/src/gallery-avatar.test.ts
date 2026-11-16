import { describe, expect, test } from "bun:test";
import { createAvatarCharacter, defaultAvatarAppearance, disposeAvatarCharacter } from "./gallery-avatar";

describe("gallery avatar characters", () => {
  test("renders each supported hair style and releases its geometry", () => {
    for (const hairStyle of ["none", "short", "long"] as const) {
      const character = createAvatarCharacter({ ...defaultAvatarAppearance, hairStyle });
      expect(character.children.length).toBe(hairStyle === "long" ? 9 : hairStyle === "short" ? 7 : 6);
      disposeAvatarCharacter(character);
    }
  });
});
