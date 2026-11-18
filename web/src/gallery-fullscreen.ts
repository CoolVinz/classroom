export async function enterGalleryFullscreen() {
  const root = document.documentElement;
  if (!root.requestFullscreen) return;
  try {
    await root.requestFullscreen({ navigationUI: "hide" });
  } catch {
    return;
  }
  if (!window.matchMedia("(pointer: coarse)").matches) return;
  const orientation = screen.orientation as (ScreenOrientation & { lock?: (value: "landscape") => Promise<void> }) | undefined;
  try { await orientation?.lock?.("landscape"); } catch { /* Orientation locking is optional. */ }
}

export function unlockGalleryOrientation() {
  const orientation = screen.orientation as (ScreenOrientation & { unlock?: () => void }) | undefined;
  orientation?.unlock?.();
}
