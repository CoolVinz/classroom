import { expect, test } from "bun:test";
import { correctionOffset, jumpHeight, reconcilePosition, walkingStep } from "./gallery-motion";

test("walking has the same bounded speed on diagonals and after a paused frame", () => {
  const straight = walkingStep(1, 0, 0, 0.05), diagonal = walkingStep(1, 1, 1.2, 0.05);
  expect(Math.hypot(diagonal.dx, diagonal.dz)).toBeCloseTo(Math.hypot(straight.dx, straight.dz));
  expect(Math.hypot(...Object.values(walkingStep(1, 0, 0, 10)))).toBeCloseTo(0.25);
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
