export const santaPath = [
  { x: -29, z: 8 },
  { x: -18, z: 8 },
  { x: -18, z: -3 },
  { x: -29, z: -3 },
];
export const santaSpeed = 2.8;
export const presentDropMs = 8000;
export const presentLifetimeMs = 20000;
export const maxPresents = 4;
export const presentOpenDistance = 2;
export const bombFuseMs = 5000;
export const bombRadius = 5;

export function advanceSanta(state, seconds) {
  let remaining = santaSpeed * Math.max(0, Math.min(0.1, seconds));
  while (remaining > 0) {
    const target = santaPath[state.nextPoint % santaPath.length];
    const dx = target.x - state.x, dz = target.z - state.z, distance = Math.hypot(dx, dz);
    if (distance <= remaining + 0.0001) {
      state.x = target.x; state.z = target.z;
      if (distance) state.rotation = Math.atan2(dx, dz);
      state.nextPoint = (state.nextPoint + 1) % santaPath.length;
      remaining -= distance;
    } else {
      state.x += dx / distance * remaining; state.z += dz / distance * remaining;
      state.rotation = Math.atan2(dx, dz);
      remaining = 0;
    }
  }
  return state;
}

export function canOpenPresent(player, present, now) {
  return present.expiresAt > now && Math.hypot(player.x - present.x, player.z - present.z) <= presentOpenDistance;
}

export function insideBombRadius(player, blast, height = 0) {
  return Math.hypot(player.x - blast.x, height - blast.y, player.z - blast.z) <= bombRadius;
}
