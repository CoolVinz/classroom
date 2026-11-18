import assert from "node:assert/strict";
import { blockPosition, distanceToNextStation, exhibitPosition, trainStartStation, trainTrack } from "./train-layout.mjs";

assert.deepEqual([0, 1, 2, 3].map(blockPosition), [
  { x: -30, z: -14 }, { x: -12, z: -14 }, { x: 12, z: -14 }, { x: 30, z: -14 },
]);
assert.equal(blockPosition(4).z - blockPosition(0).z, -17);
assert.equal(Math.abs(blockPosition(1).x - blockPosition(0).x) - 12, 6);
assert.equal(Math.abs(blockPosition(2).x - blockPosition(1).x) - 12, 12);
for (let slot = 0; slot < 40; slot++) { const position = exhibitPosition(slot); assert.ok(Math.abs(position.x) < 5); assert.ok(Math.abs(position.z) < 5); }
assert.deepEqual(exhibitPosition(40), exhibitPosition(0));
assert.deepEqual(trainTrack(0), []);
assert.deepEqual(trainTrack(4).filter((point) => point.id).map((point) => point.id), ["entrance", "row-1"]);
assert.deepEqual(trainTrack(40).filter((point) => point.id).map((point) => point.id), ["entrance", "row-3", "row-6", "row-9", "row-10"]);
assert.equal(trainStartStation(0, 400), "row-3");
assert.equal(trainStartStation(11, 400), "row-3");
assert.equal(trainStartStation(12, 400), "row-6");
assert.equal(trainStartStation(null, 400), "entrance");
const route = trainTrack(400, 12);
assert.equal(route[0].id, "row-6");
assert.ok(distanceToNextStation(route, 0, route[0].x, route[0].z) > 0);
const largeRoute = trainTrack(400);
assert.equal(largeRoute.filter((point) => point.id).length, 35);
assert.ok(Math.max(...largeRoute.map((point) => Math.abs(point.z))) < 2000);
assert.ok(largeRoute.every((point) => Number.isFinite(point.x) && Number.isFinite(point.z)));
console.log("gallery train layout checks passed");
