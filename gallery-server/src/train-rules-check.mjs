import assert from "node:assert/strict";
import { canBoardTrain, firstDepartureAt, nextDepartureAt, stationWaitMs } from "./train-rules.mjs";

assert.equal(firstDepartureAt(1000, "auto"), 11000);
assert.equal(firstDepartureAt(1000, "manual"), 0);
assert.equal(nextDepartureAt("auto", 60, 1000, 80000), 90000);
assert.equal(nextDepartureAt("auto", 120, 1000, 80000), 121000);
assert.equal(nextDepartureAt("manual", 120, 1000, 80000), 0);
assert.equal(stationWaitMs({}, "row-3", false), 6000);
assert.equal(stationWaitMs({}, "entrance", true), 10000);
assert.equal(stationWaitMs({ "row-3": 18 }, "row-3", true), 18000);
assert.equal(firstDepartureAt(1000, "auto", stationWaitMs({ entrance: 3 }, "entrance", true)), 4000);
assert.equal(nextDepartureAt("auto", 60, 1000, 50000, 15000), 65000);
assert.equal(nextDepartureAt("auto", 120, 1000, 50000, 15000), 121000);
assert.equal(canBoardTrain({ active: true, phase: "dwell", seats: 11, distance: 5 }), true);
assert.equal(canBoardTrain({ active: true, phase: "moving", seats: 0, distance: 0 }), false);
assert.equal(canBoardTrain({ active: true, phase: "waiting", seats: 12, distance: 1 }), false);
assert.equal(canBoardTrain({ active: true, phase: "waiting", seats: 0, distance: 5.01 }), false);
console.log("gallery train schedule checks passed");
