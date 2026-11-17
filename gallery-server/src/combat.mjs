export function validAim(message) {
  if (!message || typeof message.shotId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.shotId)) return null;
  const { dx, dy, dz } = message;
  if (![dx,dy,dz].every(Number.isFinite)) return null;
  const length = Math.hypot(dx,dy,dz);
  if (length < 0.99 || length > 1.01 || Math.abs(dy) > 0.75) return null;
  return { shotId: message.shotId, dx: dx/length, dy: dy/length, dz: dz/length };
}
export function advanceBolt(bolt, seconds) {
  const from = { x: bolt.x, y: bolt.y, z: bolt.z };
  const step = Math.max(0, Math.min(seconds, 0.1, (30-bolt.travelled)/20));
  const to = { x: bolt.x + bolt.dx*20*step, y: bolt.y + bolt.dy*20*step, z: bolt.z + bolt.dz*20*step };
  bolt.x=to.x; bolt.y=to.y; bolt.z=to.z; bolt.travelled += 20*step;
  return { from, to, expired: bolt.travelled >= 30 };
}
export function segmentHits(from, to, center, radius = 0.7) {
  return segmentHitFraction(from,to,center,radius) !== null;
}
export function segmentHitFraction(from,to,center,radius=0.7) {
  const vx=to.x-from.x, vy=to.y-from.y, vz=to.z-from.z;
  const length=vx*vx+vy*vy+vz*vz;
  const t=length ? Math.max(0,Math.min(1,((center.x-from.x)*vx+(center.y-from.y)*vy+(center.z-from.z)*vz)/length)) : 0;
  return Math.hypot(from.x+vx*t-center.x,from.y+vy*t-center.y,from.z+vz*t-center.z)<=radius ? t : null;
}
export function playerHitFraction(from,to,player,jump=0) {
  const hits=[0.4,1.05,1.7].map((height)=>segmentHitFraction(from,to,{x:player.x,y:jump+height,z:player.z},0.55)).filter((value)=>value!==null);
  return hits.length ? Math.min(...hits) : null;
}
export function knockPlayer(player, now) {
  if (player.role !== "student" || player.knocked || player.protectedUntil > now) return false;
  player.knocked = true; player.respawnAt = now + 10_000; player.movementEpoch++;
  return true;
}
export function respawnPlayer(player, now) {
  if (!player.knocked || player.respawnAt > now) return false;
  player.knocked = false; player.respawnAt = 0; player.x=0; player.z=0; player.rotation=0;
  player.protectedUntil=now+3000; player.movementEpoch++;
  return true;
}
