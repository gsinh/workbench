/**
 * System One decisions for a voice agent: a caller's turn, word by word, with
 * a decision model (Laya) answering typed questions after every word.
 *
 * `SystemOne` is the demo. `model.ts` is the timeline and turn-taking policy,
 * with no React and no browser APIs.
 */
export { default as SystemOne, type SystemOneProps } from "./SystemOne";
export * from "./model";
