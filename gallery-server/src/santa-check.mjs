import test from "node:test";
import assert from "node:assert/strict";
import { advanceSanta, bombFuseMs, bombRadius, canOpenPresent, maxPresents, presentDropMs, presentLifetimeMs, santaPath, santaSpeed, insideBombRadius } from "./santa.mjs";

test("Santa walks the predictable commons loop at a bounded speed", () => {
  const santa = { ...santaPath[0], nextPoint: 1, rotation: 0 };
  advanceSanta(santa, 0.1);
  assert.ok(Math.abs(Math.hypot(santa.x - santaPath[0].x, santa.z - santaPath[0].z) - santaSpeed * 0.1) < 1e-8);
  assert.equal(santa.z, 8);
  assert.equal(presentDropMs, 8000);
  assert.equal(presentLifetimeMs, 20000);
  assert.equal(maxPresents, 4);
  assert.equal(bombFuseMs, 5000);
});

test("a student can open only a nearby unexpired gift", () => {
  const gift = { x: 1, z: 2, expiresAt: 500 };
  assert.equal(canOpenPresent({ x: 3, z: 2 }, gift, 499), true);
  assert.equal(canOpenPresent({ x: 3.001, z: 2 }, gift, 499), false);
  assert.equal(canOpenPresent({ x: 1, z: 2 }, gift, 500), false);
});

test("bomb checks use spherical distance including jumping and vehicle height", () => {
  const blast = { x: 0, y: 0, z: 0 };
  assert.equal(insideBombRadius({ x: 3, z: 4 }, blast), true);
  assert.equal(insideBombRadius({ x: 3.01, z: 4 }, blast), false);
  assert.equal(insideBombRadius({ x: 0, z: 0 }, blast, bombRadius), true);
  assert.equal(insideBombRadius({ x: 0, z: 0 }, blast, bombRadius + 0.01), false);
});
