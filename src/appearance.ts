// Added by Light505 for gswitchtool (2026): the window's palette and light/dark
// mode. The choice is a per-computer preference kept in browser storage; every
// color comes from the CSS tokens in styles.css.

export const PALETTES = ["claude", "codex", "classic"] as const;
export const SCHEMES = ["system", "light", "dark"] as const;

export type Palette = (typeof PALETTES)[number];
export type Scheme = (typeof SCHEMES)[number];

export interface Appearance {
  palette: Palette;
  scheme: Scheme;
}

const PALETTE_KEY = "gswitch.palette";
const SCHEME_KEY = "gswitch.scheme";

/** Swatches shown in the picker: background, surface, accent. */
export const PALETTE_SWATCHES: Record<Palette, [string, string, string]> = {
  claude: ["#f4f2ec", "#1f1e1b", "#c96442"],
  codex: ["#ffffff", "#0d0d0d", "#5d5d66"],
  classic: ["#f4f6f9", "#111318", "#535fe7"],
};

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export function readAppearance(): Appearance {
  return {
    palette: stored(PALETTE_KEY, PALETTES, "claude"),
    scheme: stored(SCHEME_KEY, SCHEMES, "system"),
  };
}

/** Applies the appearance to the document; the default palette needs no attribute. */
export function applyAppearance({ palette, scheme }: Appearance) {
  const root = document.documentElement;
  if (palette === "claude") delete root.dataset.palette;
  else root.dataset.palette = palette;
  if (scheme === "system") delete root.dataset.scheme;
  else root.dataset.scheme = scheme;
}

export function saveAppearance(appearance: Appearance) {
  applyAppearance(appearance);
  try {
    window.localStorage.setItem(PALETTE_KEY, appearance.palette);
    window.localStorage.setItem(SCHEME_KEY, appearance.scheme);
  } catch {
    // Without storage the choice lasts until the window closes.
  }
}
