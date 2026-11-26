import assert from "node:assert/strict";
import test from "node:test";
import { avatarHeight, blockingProp, clearGround, jumpApex, signBoard, slidePastProps, studentSpaceCollision, studentTreeTrunk } from "./student-space.mjs";
import { blockPosition } from "./train-layout.mjs";

test("student props stop a swept move, including a diagonal or a jump, and leave open space", () => {
  const block = blockPosition(0), rows = studentSpaceCollision(1);
  const x = block.x + studentTreeTrunk.x, z = block.z + studentTreeTrunk.z;
  for (const sign of [-1, 1]) {
    const from = { x, z: z - 3 * sign }, to = { x, z: z + 3 * sign };
    assert.deepEqual(slidePastProps(rows, from, to), from);
    assert.ok(blockingProp(rows, from, to, 0.35, avatarHeight + jumpApex));
  }
  assert.ok(blockingProp(rows, { x: x - 1, z: z - 1 }, { x: x + 1, z: z + 1 }));
  const open = { x: block.x, z: block.z + 3 };
  assert.deepEqual(slidePastProps(rows, { x: block.x, z: block.z - 3 }, open), open);
  const signZ = block.z + signBoard.z;
  assert.ok(blockingProp(rows, { x: block.x, z: signZ - 1 }, { x: block.x, z: signZ + 1 }, 0.35, avatarHeight + jumpApex));
});

test("layout changes only add props for active slots and expose a clear nearby position", () => {
  const block = blockPosition(4), center = { x: block.x + studentTreeTrunk.x, z: block.z + studentTreeTrunk.z };
  const rows = studentSpaceCollision(5);
  assert.ok(blockingProp(rows, center, center));
  assert.equal(blockingProp(studentSpaceCollision(4), center, center), undefined);
  const nearby = clearGround(rows, center, 1);
  assert.ok(Math.hypot(nearby.x - center.x, nearby.z - center.z) < 2);
  assert.equal(blockingProp(rows, nearby, nearby, 1), undefined);
});
