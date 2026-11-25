export const defaultPatrolSettings = { car: 5, bike: 5, helicopter: 5, broom: 5, baseSeconds: 15, extraSeconds: 5, maxSeconds: 60 };
export const jailCell = { x: -29, z: 19 };
export const jailGate = { x: -25, z: 19 };
export const arrestDistance = 2;

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

export function advanceOfficer(officer, destination, seconds, chasing) {
  const dx = destination.x - officer.x, dz = destination.z - officer.z;
  const distance = Math.hypot(dx, dz);
  const step = Math.min(distance, Math.max(0, Math.min(seconds, 0.1)) * (chasing ? 18 : 4));
  if (step > 0) {
    officer.x += dx / distance * step;
    officer.z += dz / distance * step;
    officer.rotation = Math.atan2(dx, dz);
  }
  officer.walking = step > 0;
}

export function canArrest(officer, target, altitude) {
  return !target.knocked && !target.jailedUntil && altitude <= 0.3
    && Math.hypot(officer.x - target.x, officer.z - target.z) <= arrestDistance;
}

export function knockdownsUntilBreak(vehicle, targets, knock) {
  for (const target of targets) {
    if (!knock(target) || !vehicle?.rental) continue;
    vehicle.hitsRemaining--;
    if (vehicle.hitsRemaining <= 0) return true;
  }
  return false;
}
