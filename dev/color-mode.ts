/**
 * Colour mode for the harness.
 *
 * Chakra's `_dark` condition matches a `.dark` class on the root element. A
 * host app usually gets that from next-themes or similar; this harness has no
 * such thing, so without these few lines the experiments only ever render
 * light and their dark styling goes untested.
 */
const KEY = "lab-color-mode";

export function apply(mode: "light" | "dark") {
  document.documentElement.classList.toggle("dark", mode === "dark");
  document.documentElement.style.colorScheme = mode;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Private browsing, blocked storage — the toggle still works for this view.
  }
}

export function initial(): "light" | "dark" {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // fall through to the OS preference
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
