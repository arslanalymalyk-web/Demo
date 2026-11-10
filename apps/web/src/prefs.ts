import { useEffect, useState } from "react";

// Preferences are conveniences. Storage can be blocked, so every access is guarded and the app works without it.
const read = (k: string, d: string): string => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const write = (k: string, v: string): void => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export function usePrefs() {
  const [theme, setTheme] = useState(() => read("tigeris.theme", "ivory"));
  const [dir, setDir] = useState(() => read("tigeris.dir", "ltr"));
  const [motion, setMotion] = useState(() => read("tigeris.motion", "full"));
  useEffect(() => { document.documentElement.dataset.theme = theme; write("tigeris.theme", theme); }, [theme]);
  useEffect(() => { document.documentElement.dir = dir; write("tigeris.dir", dir); }, [dir]);
  useEffect(() => { document.body.dataset.motion = motion; write("tigeris.motion", motion); }, [motion]);
  return { theme, setTheme, dir, setDir, motion, setMotion };
}
