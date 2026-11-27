import assert from "node:assert/strict";
import test from "node:test";
import { addKnockdown, advanceOfficer, backupPatrol, canArrest, defaultPatrolSettings, knockdownsUntilBreak, rankWanted, sentenceSeconds } from "./patrol.mjs";
import { vehicleKinds, vehicleSpecs } from "./vehicles.mjs";
import { walkingSpeed } from "./movement.mjs";
import { aisleTreeTrunk, blockingProp, studentSpaceCollision } from "./student-space.mjs";
import { blockPosition } from "./train-layout.mjs";

test("every rental stops after exactly its limit of successful knockdowns", () => {
  for (const [index, kind] of vehicleKinds.entries()) {
    const hitLimit = index + 1;
    const vehicle = { kind, rental: true, hitsRemaining: hitLimit, hitLimit };
    const hit = [];
    const broken = knockdownsUntilBreak(vehicle, [0, 1, 2, 3, 4, 5, 6], (target) => {
      if (target === 0) return false; // An already knocked or protected target.
      hit.push(target);
      return true;
    });
    assert.equal(broken, true);
    assert.equal(vehicle.hitsRemaining, 0);
    assert.deepEqual(hit, Array.from({ length: hitLimit }, (_, index) => index + 1));
  }
  const shared = { kind: "car", rental: false, hitsRemaining: 0 };
  let hits = 0;
  assert.equal(knockdownsUntilBreak(shared, [1, 2], () => Boolean(++hits)), false);
  assert.equal(hits, 2);
});

test("counts, ties, and jail sentences use the first unserved knockdown", () => {
  const records = new Map();
  addKnockdown(records, "older", 100);
  addKnockdown(records, "newer", 200);
  addKnockdown(records, "newer", 300);
  const rank = () => Array.from(records, ([id, record]) => ({ id, ...record })).sort(rankWanted).map(({ id }) => id);
  assert.deepEqual(rank(), ["newer", "older"]);
  addKnockdown(records, "older", 400);
  assert.deepEqual(rank(), ["older", "newer"]);
  assert.equal(sentenceSeconds(defaultPatrolSettings, 1), 15);
  assert.equal(sentenceSeconds(defaultPatrolSettings, 3), 25);
  assert.equal(sentenceSeconds(defaultPatrolSettings, 100), 60);
  records.get("older").releaseAt = 5000;
  assert.equal(addKnockdown(records, "older", 600).count, 2);
});

test("the officer pursues continuously and arrest requires ground contact", () => {
  const officer = { x: 0, z: 0, rotation: 0 };
  const target = { x: 4, z: 0 };
  assert.equal(canArrest(officer, target, 0), false);
  advanceOfficer(officer, target, 0.05);
  assert.ok(Math.abs(officer.x - walkingSpeed * 0.05) < 0.00001);
  for (let i = 0; i < 22; i++) advanceOfficer(officer, target, 0.05);
  assert.equal(officer.x, target.x);
  assert.equal(canArrest(officer, target, 2), false);
  assert.equal(canArrest(officer, { ...target, knocked: true }, 0), false);
  assert.equal(canArrest(officer, { ...target, jailedUntil: 1000 }, 0), false);
  assert.equal(canArrest(officer, target, 0), true);
});

test("backup is capped at a second walker and a patrol car", () => {
  assert.deepEqual([0, 1, 2, 3, 20].map(backupPatrol), [[], [], ["foot"], ["foot", "car"], ["foot", "car"]]);
  const car = { kind: "car", x: 0, z: 0 };
  advanceOfficer(car, { x: 0, z: 5 }, 0.05);
  assert.equal(car.z, vehicleSpecs.car.speed * 0.05);
});

test("both units detour around fixed props and cannot arrest through them", () => {
  const base = blockPosition(0), x = aisleTreeTrunk.x, z = base.z;
  const props = studentSpaceCollision(1);
  assert.equal(canArrest({ x, z: z - 0.8 }, { x, z: z + 0.8 }, 0, props), false);
  for (const kind of ["foot", "car"]) {
    const officer = { kind, x, z: z - 3 }, target = { x, z: z + 3 };
    for (let tick = 0; tick < 120; tick++) {
      advanceOfficer(officer, target, 0.05, props);
      assert.equal(blockingProp(props, officer, officer), undefined);
    }
    assert.equal(canArrest(officer, target, 0, props), true, kind);
  }
});

test("a patrol car can approach a target across multiple rows", () => {
  const props = studentSpaceCollision(32), target = { x: 7, z: -120 };
  const car = { kind: "car", x: -25, z: 19 };
  for (let i = 0; i < 400 && !canArrest(car, target, 0, props); i++) advanceOfficer(car, target, 0.05, props);
  assert.equal(canArrest(car, target, 0, props), true);
});
