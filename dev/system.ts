import { createSystem, defaultConfig, defineConfig } from "@chakra-ui/react";

/**
 * The minimum theme the experiments expect.
 *
 * They are written against Chakra's own semantic tokens — `bg.panel`,
 * `fg.muted`, `border`, the `l1`/`l2`/`l3` radii — so the only thing worth
 * setting is `colorPalette`, which decides what `colorPalette.solid` and
 * `colorPalette.fg` resolve to. Change `blue` here and the accents follow;
 * the chart's own series colours are deliberately independent of it, because
 * they were validated as a set.
 */
export const system = createSystem(
  defaultConfig,
  defineConfig({ globalCss: { html: { colorPalette: "blue" } } }),
);
