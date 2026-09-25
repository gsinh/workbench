"use client";

import { Box, Button, Flex, HStack, Text } from "@chakra-ui/react";
import { type ReactNode, useEffect, useRef } from "react";

/**
 * A guided walk through an experiment: one idea per step, one highlighted
 * control, and a "Show me" that does the step for the reader.
 *
 * The tour does not own any experiment state. The host passes the steps in on
 * every render, so a step's `done` and `after` can depend on what the reader
 * has actually done — dragged the slider, heard the call — and the narration
 * responds to it rather than reciting.
 *
 * Highlighting works by attribute. The host marks regions with
 * `data-tour="name"`, and spreads `tourSpotlight(step)` into its root's
 * `css`: every marked region except the target is dimmed, and the target gets
 * an outline and a bouncing "↓" cue saying what to watch. Unmarked content is
 * left alone, so prose around the controls stays readable.
 */

export type TourStep = {
  /** The `data-tour` region this step is about. */
  target: string;
  /** The arrow's label on the target, e.g. "Watch this line". Short. */
  cue?: string;
  /** What to notice or do. One or two sentences. */
  say: ReactNode;
  /** Label for the button that performs the step, e.g. "Play it". */
  showLabel?: string;
  /** Perform the step. Called from a click, so it may start playback. */
  show?: () => void;
  /** The reader has done what the step asked. */
  done?: boolean;
  /** What to take from it, shown once `done`. */
  after?: ReactNode;
};

/**
 * CSS for the host root: dims every tour region except the target, and pins a
 * bouncing cue to the target's top edge so the eye knows where to go. The cue
 * is a pseudo-element, so it moves with the layout and needs no measuring.
 */
export function tourSpotlight(step: Pick<TourStep, "target" | "cue"> | null) {
  if (!step) return {};
  return {
    "& [data-tour]": {
      opacity: 0.35,
      transition: "opacity 200ms ease",
    },
    [`& [data-tour="${step.target}"]`]: {
      opacity: 1,
      position: "relative",
      outline: "2px solid var(--chakra-colors-color-palette-solid)",
      outlineOffset: "6px",
      borderRadius: "var(--chakra-radii-l2)",
      // Room above for the cue when the step scrolls it into view.
      scrollMarginTop: "3rem",
    },
    [`& [data-tour="${step.target}"]::before`]: {
      content: JSON.stringify(`↓ ${step.cue ?? "Look here"}`),
      position: "absolute",
      // Straddles the outline's top edge, like a label on the box.
      top: "calc(-6px - 1.35em)",
      insetInlineStart: "2",
      zIndex: 1,
      px: "2",
      py: "0.5",
      fontSize: "11px",
      fontWeight: "bold",
      lineHeight: "1.4",
      whiteSpace: "nowrap",
      color: "var(--chakra-colors-color-palette-contrast)",
      bg: "var(--chakra-colors-color-palette-solid)",
      rounded: "full",
      shadow: "sm",
      pointerEvents: "none",
      animation: "workbench-tour-bob 1.2s ease-in-out infinite",
    },
    "@media (prefers-reduced-motion: reduce)": {
      "& [data-tour]": { transition: "none" },
      [`& [data-tour="${step.target}"]::before`]: { animation: "none" },
    },
  };
}

/** The cue's and the play hint's motion. Rendered with the card. */
const keyframes = `
@keyframes workbench-tour-bob { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }
@keyframes workbench-tour-nudge { 0%, 100% { transform: translateX(0) } 50% { transform: translateX(-4px) } }
@keyframes workbench-tour-nudge-right { 0%, 100% { transform: translateX(0) } 50% { transform: translateX(4px) } }
`;

function reducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * The narration card. Render it as the last child of the demo: it is sticky
 * to the bottom of the viewport, which only holds while its natural position
 * is below the fold — true for the whole demo if it comes last.
 */
export function Tour({
  steps,
  index,
  onIndex,
  onClose,
  root,
}: {
  steps: TourStep[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** The demo's root, to find and scroll to each step's target. */
  root: HTMLElement | null;
}) {
  const step = steps[index];
  const last = index === steps.length - 1;

  const card = useRef<HTMLDivElement>(null);

  // Bring the target into view on every step change: centred in the part of
  // the screen the card does not cover, or from its top if it will not fit.
  // On a phone the card takes a third of the screen, so plain centring hides
  // the lower half of a tall target behind it.
  useEffect(() => {
    const target = root?.querySelector(`[data-tour="${step.target}"]`);
    if (!target) return;
    const box = target.getBoundingClientRect();
    const cueRoom = 48;
    const visible = window.innerHeight - (card.current?.offsetHeight ?? 0) - 24;
    const top = Math.max(cueRoom, (visible - box.height) / 2);
    window.scrollTo({
      top: window.scrollY + box.top - top,
      behavior: reducedMotion() ? "auto" : "smooth",
    });
  }, [root, step.target]);

  // Deep link: #tour-3 opens step 3. Kept in the address bar so a step can be
  // shared, and replaced rather than pushed so Back still leaves the page.
  useEffect(() => {
    if (typeof window === "undefined") return;
    history.replaceState(null, "", `#tour-${index + 1}`);
  }, [index]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <Box
      ref={card}
      role="dialog"
      aria-label="Guided tour"
      position="sticky"
      bottom="3"
      zIndex="2"
      mt="6"
      p="4"
      bg="bg.panel"
      borderWidth="1px"
      borderColor="colorPalette.muted"
      rounded="l3"
      shadow="lg"
    >
      <style>{keyframes}</style>
      <Flex justify="space-between" align="center" gap="3">
        <Text fontSize="2xs" color="fg.muted" fontVariantNumeric="tabular-nums">
          Step {index + 1} of {steps.length}
        </Text>
        <Button size="2xs" variant="ghost" onClick={onClose} aria-label="Close the tour">
          ✕
        </Button>
      </Flex>
      {/* Progress: one pip per step. */}
      <HStack gap="1" mt="2" aria-hidden>
        {steps.map((_, i) => (
          <Box
            key={i}
            h="1"
            flex="1"
            rounded="full"
            bg={i <= index ? "colorPalette.solid" : "bg.emphasized"}
            transition="background 200ms ease"
          />
        ))}
      </HStack>

      <Box aria-live="polite" mt="3">
        <Text fontSize="sm" lineHeight="short">
          {step.say}
        </Text>
        {step.done && step.after && (
          <Text fontSize="xs" color="fg.muted" mt="2" lineHeight="short">
            <Text as="span" color="green.fg" fontWeight="bold">
              ✓{" "}
            </Text>
            {step.after}
          </Text>
        )}
      </Box>

      <Flex mt="4" gap="2" wrap="wrap" justify="space-between">
        <HStack gap="2">
          {step.show && (
            <Button
              size="xs"
              variant={step.done ? "outline" : "solid"}
              onClick={step.show}
            >
              {step.showLabel ?? "Show me"}
            </Button>
          )}
          {step.show && !step.done && (
            <Text
              as="span"
              fontSize="xs"
              fontWeight="bold"
              color="colorPalette.fg"
              aria-hidden
              animation="workbench-tour-nudge 1.2s ease-in-out infinite"
              _motionReduce={{ animation: "none" }}
            >
              ← try it
            </Text>
          )}
        </HStack>
        <HStack gap="2">
          <Button size="xs" variant="ghost" onClick={() => onIndex(index - 1)} disabled={index === 0}>
            Back
          </Button>
          <Button
            size="xs"
            variant={step.show && !step.done ? "outline" : "solid"}
            onClick={() => (last ? onClose() : onIndex(index + 1))}
          >
            {last ? "Explore on your own" : "Next"}
          </Button>
        </HStack>
      </Flex>
    </Box>
  );
}

/**
 * The button that starts a tour, with a "try it →" nudge beside it. Shown on
 * every visit, not just the first: the tour is the way in for most readers,
 * and a returning one may be showing the page to someone else.
 */
export function TourButton({ onStart }: { id?: string; onStart: () => void }) {
  return (
    <HStack gap="2">
      <style>{keyframes}</style>
      <Text
        as="span"
        fontSize="xs"
        fontWeight="bold"
        color="colorPalette.fg"
        aria-hidden
        animation="workbench-tour-nudge-right 1.2s ease-in-out infinite"
        _motionReduce={{ animation: "none" }}
      >
        try it →
      </Text>
      <Button size="xs" onClick={onStart}>
        ▶ Take the 1-minute tour
      </Button>
    </HStack>
  );
}

/** Step to open from a `#tour-N` link, or null. */
export function tourFromHash(): number | null {
  if (typeof window === "undefined") return null;
  const match = /^#tour-(\d+)$/.exec(window.location.hash);
  return match ? Number(match[1]) - 1 : null;
}

/** Clear the `#tour-N` link on close. */
export function clearTourHash() {
  if (typeof window === "undefined") return;
  if (/^#tour-\d+$/.test(window.location.hash)) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
}
