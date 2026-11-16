export function boundedMove(previous, message, elapsedSeconds) {
  if (!message || !Number.isFinite(message.x) || !Number.isFinite(message.z) || !Number.isFinite(message.rotation)) return null;
  const elapsed = Math.min(1, Math.max(0.05, elapsedSeconds));
  const dx = message.x - previous.x, dz = message.z - previous.z;
  if (Math.hypot(dx, dz) > 5 * elapsed + 0.25 || Math.abs(message.x) > 2000 || Math.abs(message.z) > 2000) return null;
  return { x: message.x, z: message.z, rotation: ((message.rotation % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) };
}
