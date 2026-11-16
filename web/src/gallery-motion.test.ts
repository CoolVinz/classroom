import { expect, test } from "bun:test";
import { jumpHeight, reconcilePosition, walkingStep } from "./gallery-motion";

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
