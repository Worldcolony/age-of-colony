// Derive a stable neon accent color from a wallet pubkey (FNV-1a -> HSL).

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

function hslToHex(h: number, s: number, l: number): string {
  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function accentHex(pubkey?: string | null): string {
  if (!pubkey) return "#38E8FF";
  const h = hashStr(pubkey);
  const hue = (h & 0xffff) / 0xffff;
  const sat = 0.62 + (((h >>> 16) & 0xff) / 255) * 0.28;
  const lig = 0.55 + (((h >>> 24) & 0xff) / 255) * 0.1;
  return hslToHex(hue, sat, lig);
}

export function shortAddress(pubkey?: string | null): string {
  if (!pubkey) return "";
  return pubkey.length <= 9 ? pubkey : `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}
