export type Position = { x: number; z: number; rotation: number };
export type Move = { sequence: number; dx: number; dz: number };

export function walkingStep(forward: number, side: number, yaw: number, seconds: number) {
  const length = Math.max(1, Math.hypot(forward, side));
  const distance = 5 * Math.min(0.05, Math.max(0, seconds)) / length;
  return { dx: (Math.sin(yaw) * forward + Math.cos(yaw) * side) * distance, dz: (-Math.cos(yaw) * forward + Math.sin(yaw) * side) * distance };
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
