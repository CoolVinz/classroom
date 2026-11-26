import test from "node:test";
import assert from "node:assert/strict";
import { knockPlayer, respawnPlayer } from "./combat.mjs";
import { advanceFuelLanding, advanceVehicle, flightFuelRemaining, hitsMovingBody, LANDING_HEIGHT, MAX_FLIGHT_HEIGHT, trainBodies, validVehicleInput, vehicleRespawn, vehicleSpecs } from "./vehicles.mjs";

test("fuel is used at takeoff and while hovering, and a forced landing reaches clear ground", () => {
  assert.equal(flightFuelRemaining(30, 0, 0, 20), 30);
  assert.equal(flightFuelRemaining(30, 0, 1, 0.5), 29.5);
  assert.equal(flightFuelRemaining(7, 2, 0, 4), 3);
  assert.equal(flightFuelRemaining(3, 2, 1, 4), 0);
  let vehicle = { x: 1, y: 1, z: 2, rotation: 0 };
  const target = { x: 5, z: 2 };
  for (let tick = 0; tick < 15; tick++) vehicle = advanceFuelLanding(vehicle, target, 0.05);
  assert.ok(vehicle.y > LANDING_HEIGHT && vehicle.x < target.x);
  for (let tick = 0; tick < 10; tick++) vehicle = advanceFuelLanding(vehicle, target, 0.05);
  assert.deepEqual(vehicle, { ...target, y: 0, rotation: 0 });
});

test("moving train checks its engine and trailing cars across a tick, with narrow clearance at the sides", () => {
  const from = { x: 0, y: 0, z: 0, rotation: 0 }, to = { ...from, z: 2 };
  const hit = (x, z, jump = 0) => trainBodies.some((body) => hitsMovingBody(from, to, body, { x, z }, jump));
  assert.equal(hit(0, 4.8), true);
  assert.equal(hit(0, -7), true);
  assert.equal(hit(2.5, -7), false);
  assert.equal(hit(0, 4.8, 3), false);
  assert.equal(hitsMovingBody(from, from, trainBodies[0], { x: 0, z: 2.3 }, 0), false);
  const turn = { x: -2, y: 0, z: 1, rotation: Math.PI / 2 };
  assert.equal(hitsMovingBody(turn, { ...turn, x: 0 }, trainBodies[0], { x: 2, z: 1 }, 0), true);
});

test("driving and flight use bounded inputs, and a helicopter only hits at avatar height", () => {
  assert.ok(validVehicleInput({ throttle: 1, turn: -1, lift: 0.5 }));
  assert.equal(validVehicleInput({ throttle: 1.1, turn: 0, lift: 0 }), false);
  assert.equal(validVehicleInput({ throttle: NaN, turn: 0, lift: 0 }), false);
  const input = { throttle: 1, turn: 0, lift: 1 };
  const origin = { x: 0, y: 0, z: 0, rotation: 0 };
  assert.deepEqual(advanceVehicle({ ...origin, kind: "car" }, input, 0.5, { minZ: -35 }), { ...origin, z: 6 });
  assert.deepEqual(advanceVehicle({ ...origin, kind: "bike" }, input, 0.5, { minZ: -35 }), { ...origin, z: 7.5 });
  const airborne = { ...origin, kind: "helicopter", y: 11 };
  const next = advanceVehicle(airborne, input, 0.5, { minZ: -35 });
  assert.equal(next.y, MAX_FLIGHT_HEIGHT);
  assert.equal(hitsMovingBody(airborne, next, vehicleSpecs.helicopter, { x: 0, z: 4 }, 0), false);
  assert.equal(hitsMovingBody(origin, { ...origin, y: 3 }, vehicleSpecs.helicopter, { x: 0, z: 0 }, 0), true);
});

test("vehicle respawn works for teachers and preserves the full protection window", () => {
  const teacher = { role: "teacher", x: 0, z: 2, rotation: 0, movementEpoch: 0, protectedUntil: 0 };
  assert.equal(knockPlayer(teacher, 100, "train"), true);
  assert.equal(teacher.knockCause, "train");
  assert.equal(teacher.respawnAt, 10100);
  assert.equal(respawnPlayer(teacher, 10099), false);
  assert.equal(respawnPlayer(teacher, 10100), true);
  assert.deepEqual({ x: teacher.x, z: teacher.z }, vehicleRespawn);
  assert.equal(teacher.protectedUntil, 13100);
  assert.equal(knockPlayer(teacher, 13099, "bike"), false);
  assert.equal(knockPlayer(teacher, 13100, "bike"), true);
});
