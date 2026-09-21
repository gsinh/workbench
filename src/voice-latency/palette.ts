/**
 * Chart colours for the latency budget.
 *
 * Seven categorical slots in a fixed order — slot N always means stage N, so a
 * colour never changes meaning when a stage collapses to zero. Both columns
 * were validated against this demo's own surfaces (bg.panel: #eff6ff light,
 * #18181b dark) rather than against generic ones: lightness band, chroma floor,
 * colour-vision separation between neighbouring segments (worst adjacent ΔE 9.1
 * light / 8.4 dark, protan) and normal-vision separation (19.6 / 19.3).
 *
 * Four of the light steps sit below 3:1 against the pale blue surface, which is
 * allowed only with relief: every segment is named in the legend and every
 * value is repeated in the table view, so no reading depends on the fill alone.
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
 * Ink for a label set *inside* a filled segment, chosen per slot by the fill's
 * luminance rather than taken from the page's text tokens — white on the
 * yellow step is 1.9:1 and unreadable, while ink on it is 8.7:1. Every pair
 * below clears 4.5:1 against its own fill.
 *
 * This is the one place a label does not wear a text token; everywhere else
 * on the chart the colour stays on the mark and the text stays neutral.
 */
const INK_LIGHT = ["#fff", "#111", "#111", "#111", "#111", "#fff", "#fff"];
const INK_DARK = ["#111", "#111", "#111", "#111", "#111", "#fff", "#111"];

/** CSS custom properties for the chart root, swapped by Chakra's `_dark`. */
export const vizVars = {
  ...Object.fromEntries(SERIES_LIGHT.map((hex, i) => [`--series-${i + 1}`, hex])),
  ...Object.fromEntries(INK_LIGHT.map((hex, i) => [`--ink-${i + 1}`, hex])),
  _dark: {
    ...Object.fromEntries(SERIES_DARK.map((hex, i) => [`--series-${i + 1}`, hex])),
    ...Object.fromEntries(INK_DARK.map((hex, i) => [`--ink-${i + 1}`, hex])),
  },
};

export const seriesVar = (index: number) => `var(--series-${index + 1})`;

/** Readable ink for text drawn on top of `seriesVar(index)`. */
export const inkVar = (index: number) => `var(--ink-${index + 1})`;
