/**
 * Google Fonts shipped with the app (latin subset, WOFF, via Fontsource).
 * All are free to use: SIL Open Font License 1.1.
 */
export interface BundledFont {
  id: string;
  label: string;
  /** npm path of the font file */
  file: string;
}

export const BUNDLED_FONTS: BundledFont[] = [
  { id: 'bebas-neue', label: 'Bebas Neue (strak, hoog)', file: '@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff' },
  { id: 'montserrat', label: 'Montserrat (modern)', file: '@fontsource/montserrat/files/montserrat-latin-700-normal.woff' },
  { id: 'cinzel', label: 'Cinzel (Romeins, klassiek)', file: '@fontsource/cinzel/files/cinzel-latin-700-normal.woff' },
  { id: 'playfair-display', label: 'Playfair Display (sierlijk)', file: '@fontsource/playfair-display/files/playfair-display-latin-700-normal.woff' },
  { id: 'dm-serif-display', label: 'DM Serif Display (deftig)', file: '@fontsource/dm-serif-display/files/dm-serif-display-latin-400-normal.woff' },
  { id: 'abril-fatface', label: 'Abril Fatface (dik, retro)', file: '@fontsource/abril-fatface/files/abril-fatface-latin-400-normal.woff' },
  { id: 'fredoka', label: 'Fredoka (rond, vrolijk)', file: '@fontsource/fredoka/files/fredoka-latin-600-normal.woff' },
  { id: 'comfortaa', label: 'Comfortaa (rond, licht)', file: '@fontsource/comfortaa/files/comfortaa-latin-700-normal.woff' },
  { id: 'righteous', label: 'Righteous (art deco)', file: '@fontsource/righteous/files/righteous-latin-400-normal.woff' },
  { id: 'bungee', label: 'Bungee (blokletters)', file: '@fontsource/bungee/files/bungee-latin-400-normal.woff' },
  { id: 'orbitron', label: 'Orbitron (futuristisch)', file: '@fontsource/orbitron/files/orbitron-latin-700-normal.woff' },
  { id: 'space-mono', label: 'Space Mono (typemachine)', file: '@fontsource/space-mono/files/space-mono-latin-700-normal.woff' },
  { id: 'lobster', label: 'Lobster (schrijfletter)', file: '@fontsource/lobster/files/lobster-latin-400-normal.woff' },
  { id: 'pacifico', label: 'Pacifico (handgeschreven)', file: '@fontsource/pacifico/files/pacifico-latin-400-normal.woff' },
];

export const FONT_OPTIONS = BUNDLED_FONTS.map((f) => ({ value: `bundled:${f.id}`, label: f.label }));

/** Fontsource id for a Google Font family name ("Open Sans" → "open-sans"). */
export function fontsourceId(family: string) {
  return family
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Free CDN copy of any Google Font (CORS enabled), latin subset. */
export function googleFontUrl(family: string, weight: number) {
  return `https://cdn.jsdelivr.net/fontsource/fonts/${fontsourceId(family)}@latest/latin-${weight}-normal.woff`;
}

export function googleFontInfoUrl(family: string) {
  return `https://api.fontsource.org/v1/fonts/${fontsourceId(family)}`;
}

/**
 * The font key for a font choice: a bundled id, or a Google Font typed by
 * name ("Google: Roboto Slab, 700").
 */
export function fontKey(choice: string, googleFamily: string, weight: number) {
  if (choice === 'google') return googleFamily.trim() ? `google:${googleFamily.trim()}:${weight}` : 'bundled:montserrat';
  return choice;
}
