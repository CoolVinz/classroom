export function boundedMove(previous, message, elapsedSeconds, maxCoordinate = 2000) {
  if (!message) return null;
  const elapsed = Math.min(1, Math.max(0.05, elapsedSeconds));
  const delta = message.sequence !== undefined;
  if (delta && (!Number.isSafeInteger(message.sequence) || message.sequence <= (previous.sequence ?? 0))) return null;
  const x = delta ? previous.x + message.dx : message.x, z = delta ? previous.z + message.dz : message.z;
  const dx = x - previous.x, dz = z - previous.z;
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.hypot(dx, dz) > 5 * elapsed + 0.25 || Math.abs(x) > maxCoordinate || Math.abs(z) > maxCoordinate) return null;
  const rotation = dx || dz ? Math.atan2(dx, dz) : previous.rotation;
  return { x, z, rotation: ((rotation % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) };
}
