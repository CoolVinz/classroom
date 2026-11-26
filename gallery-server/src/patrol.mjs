import { avatarRadius, blockingProp, clearGround } from "./student-space.mjs";
import { vehicleSpecs } from "./vehicles.mjs";
import { walkingSpeed } from "./movement.mjs";

export const defaultPatrolSettings = { car: 5, bike: 5, helicopter: 5, broom: 5, baseSeconds: 15, extraSeconds: 5, maxSeconds: 60, helicopterFuelSeconds: 30, broomFuelSeconds: 30 };
export const jailCell = { x: -29, z: 19 };
export const jailGate = { x: -25, z: 19 };
export const arrestDistance = 2;

export function backupPatrol(count) {
  return count >= 3 ? ["foot", "car"] : count >= 2 ? ["foot"] : [];
}

export function rankWanted(a, b) {
  return b.count - a.count || a.since - b.since || a.id.localeCompare(b.id);
}

export function addKnockdown(records, accountId, now) {
  const record = records.get(accountId) ?? { count: 0, since: now, releaseAt: 0 };
  if (record.releaseAt) return record;
  record.count++;
  records.set(accountId, record);
  return record;
}

export function sentenceSeconds(settings, count) {
  return Math.min(settings.maxSeconds, settings.baseSeconds + Math.max(0, count - 1) * settings.extraSeconds);
}

function patrolWaypoint(officer, destination, props, radius) {
  const firstProp = blockingProp(props, officer, destination, radius);
  if (!firstProp) return destination;
  const queued = new Set([firstProp]);
  for (const prop of queued) {
    const x = prop.halfWidth + radius + 0.12, z = prop.halfDepth + radius + 0.12;
    const corners = [[-x, -z], [x, -z], [x, z], [-x, z]].map(([dx, dz]) => ({ x: prop.x + dx, z: prop.z + dz }));
    let waypoint, best = Infinity;
    for (const [index, first] of corners.entries()) {
      const entry = Math.hypot(first.x - officer.x, first.z - officer.z);
      if (entry < 0.001) continue;
      const obstruction = blockingProp(props, officer, first, radius);
      if (obstruction) {
        if (queued.size < 6) queued.add(obstruction);
        continue;
      }
      for (const offset of [0, 1, 3]) {
        const exit = corners[(index + offset) % 4];
        if (offset && blockingProp(props, first, exit, radius)) continue;
        if (blockingProp(props, exit, destination, radius) === prop) continue;
        const cost = entry + Math.hypot(exit.x - first.x, exit.z - first.z) + Math.hypot(destination.x - exit.x, destination.z - exit.z);
        if (cost < best) { best = cost; waypoint = first; }
      }
    }
    if (waypoint) return waypoint;
  }
  return officer;
}

export function advanceOfficer(officer, destination, seconds, props = []) {
  const car = officer.kind === "car";
  const radius = car ? vehicleSpecs.car.halfWidth : avatarRadius;
  const approach = clearGround(props, destination, radius);
  const waypoint = patrolWaypoint(officer, approach, props, radius);
  const dx = waypoint.x - officer.x, dz = waypoint.z - officer.z;
  const distance = Math.hypot(dx, dz);
  const step = Math.min(distance, Math.max(0, Math.min(seconds, 0.1)) * (car ? vehicleSpecs.car.speed : walkingSpeed));
  if (step > 0) {
    officer.x += dx / distance * step;
    officer.z += dz / distance * step;
    officer.rotation = Math.atan2(dx, dz);
  }
  officer.walking = step > 0;
}

export function canArrest(officer, target, altitude, props = []) {
  return !target.knocked && !target.jailedUntil && altitude <= 0.3
    && Math.hypot(officer.x - target.x, officer.z - target.z) <= arrestDistance
    && !blockingProp(props, officer, target, 0.04);
}

export function knockdownsUntilBreak(vehicle, targets, knock) {
  for (const target of targets) {
    if (!knock(target) || !vehicle?.rental) continue;
    vehicle.hitsRemaining--;
    if (vehicle.hitsRemaining <= 0) return true;
  }
  return false;
}
