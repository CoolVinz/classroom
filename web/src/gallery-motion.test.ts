import { expect, test } from "bun:test";
import { correctionOffset, directionFromCamera, facingRotation, interpolateTrain, jumpHeight, reconcilePosition, touchDirection, walkingStep } from "./gallery-motion";

test("walking has the same bounded speed on diagonals and after a paused frame", () => {
  const straight = walkingStep(1, 0, 0, 0.05), diagonal = walkingStep(1, 1, 1.2, 0.05);
  expect(Math.hypot(diagonal.dx, diagonal.dz)).toBeCloseTo(Math.hypot(straight.dx, straight.dz));
  expect(Math.hypot(...Object.values(walkingStep(1, 0, 0, 10)))).toBeCloseTo(0.25);
});

test("WASD travel and character facing follow camera-relative directions", () => {
  const expected = [
    { yaw: 0, forward: 1, side: 0, dx: 0, dz: -1 },
    { yaw: 0, forward: 0, side: -1, dx: -1, dz: 0 },
    { yaw: Math.PI / 2, forward: 1, side: 0, dx: -1, dz: 0 },
    { yaw: Math.PI / 2, forward: 0, side: 1, dx: 0, dz: -1 },
  ];
  for (const item of expected) {
    const step = walkingStep(item.forward, item.side, item.yaw, 0.05);
    expect(step.dx).toBeCloseTo(item.dx * 0.25);
    expect(step.dz).toBeCloseTo(item.dz * 0.25);
    const angle = facingRotation(step.dx, step.dz);
    expect(Math.sin(angle)).toBeCloseTo(item.dx);
    expect(Math.cos(angle)).toBeCloseTo(item.dz);
  }
});

test("camera aim targets a point along its world-space ray from the muzzle", () => {
  const aim = directionFromCamera({ x: 0, y: 0, z: -1 }, { x: 2, y: 1, z: 0 }, { x: 2, y: 3, z: 8 });
  expect(aim.dx).toBeCloseTo(0);
  expect(aim.dy).toBeCloseTo(2 / Math.hypot(2, 22));
  expect(aim.dz).toBeCloseTo(-22 / Math.hypot(2, 22));
});

test("delayed acknowledgements preserve later movement and server corrections", () => {
  const pending = [{ sequence: 1, dx: 0.5, dz: 0 }, { sequence: 2, dx: 0.5, dz: 0 }];
  const server = { x: 0.5, z: 0, rotation: 0 };
  expect(reconcilePosition(server, 1, pending, { dx: 0.2, dz: 0 })).toEqual({ x: 1.2, z: 0 });
  expect(reconcilePosition({ ...server, x: 0 }, 1, pending, { dx: 0.2, dz: 0 })).toEqual({ x: 0.7, z: 0 });
  expect(reconcilePosition({ ...server, x: 1 }, 2, pending, { dx: 0.2, dz: 0 })).toEqual({ x: 1.2, z: 0 });
});

test("jump rises and lands without allowing a permanent height change", () => {
  expect(jumpHeight(0)).toBe(0);
  expect(jumpHeight(0.375)).toBeCloseTo(1.125);
  expect(jumpHeight(0.75)).toBe(0);
  expect(jumpHeight(10)).toBe(0);
});

test("small corrections preserve rendered position while large corrections snap", () => {
  const previous = { x: 1, z: 2 }, corrected = { x: 0.8, z: 2.1 };
  const offset = correctionOffset(previous, corrected, { x: 0.1, z: 0 });
  expect(corrected.x + offset.x).toBeCloseTo(1.1);
  expect(corrected.z + offset.z).toBeCloseTo(2);
  expect(correctionOffset(previous, { x: 20, z: 2 }, offset)).toEqual({ x: 0, z: 0 });
  const decay = Math.exp(-12 / 60);
  expect(Math.abs(offset.x * decay)).toBeLessThan(Math.abs(offset.x));
});

test("train interpolation follows the same buffered position through turns and holds without updates", () => {
  const samples = [
    { at: 100, x: 0, z: 0, rotation: Math.PI - 0.1 },
    { at: 200, x: 10, z: 20, rotation: -Math.PI + 0.1 },
  ];
  expect(interpolateTrain(samples, 250)).toMatchObject({ x: 5, z: 10 });
  expect(Math.abs(interpolateTrain(samples, 250)!.rotation)).toBeCloseTo(Math.PI);
  expect(interpolateTrain(samples, 1000)).toEqual(samples[1]);
  expect(interpolateTrain([], 1000)).toBeNull();
});

test("touch joystick clamps to a circular range while preserving diagonal direction", () => {
  expect(touchDirection(25, 0, 25)).toEqual({ x: 1, z: 0 });
  const diagonal = touchDirection(50, 50, 25);
  expect(Math.hypot(diagonal.x, diagonal.z)).toBeCloseTo(1);
  expect(diagonal.x).toBeCloseTo(diagonal.z);
});
