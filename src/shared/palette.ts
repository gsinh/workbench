/**
 * Chart colours, shared by every experiment.
 *
 * Seven categorical slots in a fixed order, validated against this package's
 * own surfaces (#eff6ff light, #18181b dark) rather than generic ones:
 * lightness band, chroma floor, colour-vision separation between neighbouring
 * marks (worst adjacent ΔE 9.1 light / 8.4 dark, protan) and normal-vision
 * separation (19.6 / 19.3).
 *
 * The order is the safety mechanism, not decoration — a slot always means the
 * same series, and slots are never cycled or generated.
 *
 * For marks compared in every direction rather than only against neighbours —
 * a scatter plot, where any two points may sit side by side — only the first
 * three slots clear the floors as a set. Charts of that kind cap there.
 */
export const SERIES_LIGHT = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
  "#008300", // green
  "#4a3aa7", // violet
] as const;

export const SERIES_DARK = [
  "#3987e5",
  "#d95926",
  "#199e70",
  "#c98500",
  "#d55181",
  "#008300",
  "#9085e9",
] as const;

/**
 * Ink for a label set *inside* a filled mark, chosen per slot by the fill's
 * luminance rather than taken from the page's text tokens — white on the
 * yellow step is 1.9:1 and unreadable, while ink on it is 8.7:1.
 */
export const INK_LIGHT = ["#fff", "#111", "#111", "#111", "#111", "#fff", "#fff"];
export const INK_DARK = ["#111", "#111", "#111", "#111", "#111", "#fff", "#111"];

/** CSS custom properties for a chart root, swapped by Chakra's `_dark`. */
export const vizVars = {
  ...Object.fromEntries(SERIES_LIGHT.map((hex, i) => [`--series-${i + 1}`, hex])),
  ...Object.fromEntries(INK_LIGHT.map((hex, i) => [`--ink-${i + 1}`, hex])),
  _dark: {
    ...Object.fromEntries(SERIES_DARK.map((hex, i) => [`--series-${i + 1}`, hex])),
    ...Object.fromEntries(INK_DARK.map((hex, i) => [`--ink-${i + 1}`, hex])),
  },
};

export const seriesVar = (index: number) => `var(--series-${(index % 7) + 1})`;

/** Readable ink for text drawn on top of `seriesVar(index)`. */
export const inkVar = (index: number) => `var(--ink-${(index % 7) + 1})`;
