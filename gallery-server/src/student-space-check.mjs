import assert from "node:assert/strict";
import test from "node:test";
import { aisleTreeTrunk, avatarHeight, blockingProp, clearGround, jumpApex, slidePastProps, studentSpaceCollision } from "./student-space.mjs";
import { blockPosition } from "./train-layout.mjs";

test("aisle trees block movement, while the old exhibit trees and signs leave no colliders", () => {
  const block = blockPosition(0), rows = studentSpaceCollision(1);
  const x = aisleTreeTrunk.x, z = block.z;
  for (const sign of [-1, 1]) {
    const from = { x, z: z - 3 * sign }, to = { x, z: z + 3 * sign };
    assert.deepEqual(slidePastProps(rows, from, to), from);
    assert.ok(blockingProp(rows, from, to, 0.35, avatarHeight + jumpApex));
  }
  assert.ok(blockingProp(rows, { x: x - 1, z: z - 1 }, { x: x + 1, z: z + 1 }));
  for (const slotX of [block.x, block.x + 5.08]) {
    const open = { x: slotX, z: block.z + 5 };
    assert.deepEqual(slidePastProps(rows, { x: slotX, z: block.z - 5 }, open, avatarHeight + jumpApex), open);
  }
});

test("layout changes only add props for active slots and expose a clear nearby position", () => {
  const block = blockPosition(4), center = { x: aisleTreeTrunk.x, z: block.z };
  const rows = studentSpaceCollision(5);
  assert.ok(blockingProp(rows, center, center));
  assert.equal(blockingProp(studentSpaceCollision(4), center, center), undefined);
  const nearby = clearGround(rows, center, 1);
  assert.ok(Math.hypot(nearby.x - center.x, nearby.z - center.z) < 2);
  assert.equal(blockingProp(rows, nearby, nearby, 1), undefined);
});
