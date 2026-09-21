/**
 * Voice agent latency budget.
 *
 * `VoiceLatency` is the whole interactive demo. Everything else is exported
 * because the pieces are useful on their own — in particular `model`, which is
 * plain TypeScript with no React and no browser APIs, so it can be lifted into
 * a test, a script or a different UI entirely.
 */
export { default as VoiceLatency } from "./VoiceLatency";
export { BudgetChart, BudgetTable, Legend, type Row } from "./Budget";
export { Choice, Knob } from "./Controls";
export { Measure } from "./Measure";
export * from "./model";
export * from "./palette";
