import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAppearance, defaultAppearance } from "./avatar.mjs";

test("account appearance is applied to the player with defaults for legacy values", () => {
  const player = {};
  applyAppearance(player);
  assert.deepEqual(player, defaultAppearance);
  applyAppearance(player, { ...defaultAppearance, skinColor: "#ffffff", hairStyle: "long" });
  assert.equal(player.skinColor, "#ffffff");
  assert.equal(player.hairStyle, "long");
  assert.equal(player.shirtColor, defaultAppearance.shirtColor);
});
