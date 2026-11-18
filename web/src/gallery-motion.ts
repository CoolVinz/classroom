export type Position = { x: number; z: number; rotation: number };
export type Move = { sequence: number; dx: number; dz: number };
export type TrainSample = { at: number; x: number; z: number; rotation: number };

export function touchDirection(dx: number, dz: number, radius: number) {
  let x = dx / radius, z = dz / radius;
  const length = Math.hypot(x, z);
  if (length > 1) { x /= length; z /= length; }
  return { x, z };
}

export function interpolateTrain(samples: readonly TrainSample[], now: number, delay = 100) {
  if (!samples.length) return null;
  const target = now - delay;
  if (target <= samples[0]!.at) return samples[0]!;
  for (let index = 1; index < samples.length; index++) {
    const next = samples[index]!;
    if (target <= next.at) {
      const previous = samples[index - 1]!;
      const fraction = (target - previous.at) / Math.max(1, next.at - previous.at);
      const rotationDelta = Math.atan2(Math.sin(next.rotation - previous.rotation), Math.cos(next.rotation - previous.rotation));
      return { at: target, x: previous.x + (next.x - previous.x) * fraction, z: previous.z + (next.z - previous.z) * fraction, rotation: previous.rotation + rotationDelta * fraction };
    }
  }
  return samples[samples.length - 1]!;
}

export function walkingStep(forward: number, side: number, yaw: number, seconds: number) {
  const length = Math.max(1, Math.hypot(forward, side));
  const distance = 5 * Math.min(0.05, Math.max(0, seconds)) / length;
  // yaw is the camera's orbit around the player; W follows the direction away from the camera.
  return { dx: (-Math.sin(yaw) * forward + Math.cos(yaw) * side) * distance, dz: (-Math.cos(yaw) * forward - Math.sin(yaw) * side) * distance };
}

export function facingRotation(dx: number, dz: number) { return Math.atan2(dx, dz); }

export function directionFromCamera(direction: { x: number; y: number; z: number }, origin: { x: number; y: number; z: number }, cameraPosition: { x: number; y: number; z: number }, distance = 30) {
  const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
  const target = { x: cameraPosition.x + direction.x / length * distance, y: cameraPosition.y + direction.y / length * distance, z: cameraPosition.z + direction.z / length * distance };
  const dx = target.x - origin.x, dy = target.y - origin.y, dz = target.z - origin.z;
  const magnitude = Math.hypot(dx, dy, dz) || 1;
  return { dx: dx / magnitude, dy: dy / magnitude, dz: dz / magnitude };
}

export function reconcilePosition(server: Position, acknowledged: number, pending: Move[], unsent: { dx: number; dz: number }) {
  const remaining = pending.filter((move) => move.sequence > acknowledged);
  return { x: server.x + unsent.dx + remaining.reduce((sum, move) => sum + move.dx, 0), z: server.z + unsent.dz + remaining.reduce((sum, move) => sum + move.dz, 0) };
}

export function jumpHeight(seconds: number) {
  return seconds > 0 && seconds < 0.75 ? Math.max(0, 6 * seconds - 8 * seconds * seconds) : 0;
}

// Keep small server corrections visually continuous; teleport large corrections immediately.
export function correctionOffset(previous: { x: number; z: number }, corrected: { x: number; z: number }, offset: { x: number; z: number }) {
  const x = previous.x + offset.x - corrected.x, z = previous.z + offset.z - corrected.z;
  return Math.hypot(x, z) > 2 ? { x: 0, z: 0 } : { x, z };
}
