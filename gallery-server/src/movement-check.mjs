import test from "node:test";
import assert from "node:assert/strict";
import { boundedMove } from "./movement.mjs";

test("accepts bounded movement and normalizes rotation", () => {
  assert.deepEqual(boundedMove({ x: 0, z: 0 }, { x: 0.5, z: 0, rotation: -1 }, 0.1), { x: 0.5, z: 0, rotation: Math.PI / 2 });
});
test("rejects teleports, world-boundary escapes, and malformed positions", () => {
  assert.equal(boundedMove({ x: 0, z: 0 }, { x: 50, z: 0, rotation: 0 }, 0.1), null);
  assert.equal(boundedMove({ x: 0, z: 0 }, { x: 2001, z: 0, rotation: 0 }, 1), null);
  assert.equal(boundedMove({ x: 0, z: 0 }, { x: NaN, z: 0, rotation: 0 }, 1), null);
});

test("accepts the extended movement bound used by large gallery routes", () => {
  assert.equal(boundedMove({ x: 0, z: 2499, rotation: 0 }, { sequence: 1, dx: 0, dz: 0.5 }, 0.2, 2600)?.z, 2499.5);
  assert.equal(boundedMove({ x: 0, z: 2499, rotation: 0 }, { sequence: 1, dx: 0, dz: 0.5 }, 0.2), null);
});
test("validates sequenced inputs and rejects duplicate or excessive displacement", () => {
  const player = { x: 2, z: 3, sequence: 1 };
  assert.deepEqual(boundedMove(player, { sequence: 2, dx: 0.5, dz: 0, rotation: 0 }, 0.1), { x: 2.5, z: 3, rotation: Math.PI / 2 });
  assert.equal(boundedMove(player, { sequence: 1, dx: 0.5, dz: 0, rotation: 0 }, 0.1), null);
  assert.equal(boundedMove(player, { sequence: 2, dx: 50, dz: 0, rotation: 0 }, 0.1), null);
  assert.equal(boundedMove(player, { sequence: 2, dx: NaN, dz: 0, rotation: 0 }, 0.1), null);
  assert.equal(boundedMove(player, { sequence: 2, dx: "1", dz: 0, rotation: 0 }, 0.1), null);
});

test("accepted movement determines facing and ignores client-supplied rotation", () => {
  assert.equal(boundedMove({ x: 0, z: 0, rotation: 0 }, { x: 0, z: -0.25, rotation: 2.4 }, 0.1).rotation, Math.PI);
  assert.equal(boundedMove({ x: 0, z: 0, rotation: 0 }, { x: 0.25, z: 0, rotation: -7 }, 0.1).rotation, Math.PI / 2);
});
