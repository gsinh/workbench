"use client";

import { Box, Button, Flex, HStack, Text } from "@chakra-ui/react";
import { type ReactNode, useEffect, useState } from "react";

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
 * `data-tour="name"`, and spreads `tourSpotlight(target)` into its root's
 * `css`: every marked region except the target is dimmed. Unmarked content is
 * left alone, so prose around the controls stays readable.
 */

export type TourStep = {
  /** The `data-tour` region this step is about. */
  target: string;
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

/** CSS for the host root: dims every tour region except the target. */
export function tourSpotlight(target: string | null) {
  if (!target) return {};
  return {
    "& [data-tour]": {
      opacity: 0.35,
      transition: "opacity 200ms ease",
    },
    [`& [data-tour="${target}"]`]: {
      opacity: 1,
      outline: "2px solid var(--chakra-colors-color-palette-solid)",
      outlineOffset: "6px",
      borderRadius: "var(--chakra-radii-l2)",
    },
    "@media (prefers-reduced-motion: reduce)": {
      "& [data-tour]": { transition: "none" },
    },
  };
}

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

  // Bring the target into view on every step change.
  useEffect(() => {
    const target = root?.querySelector(`[data-tour="${step.target}"]`);
    target?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
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
            <Button size="xs" variant={step.done ? "outline" : "solid"} onClick={step.show}>
              {step.showLabel ?? "Show me"}
            </Button>
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
 * The button that starts a tour, pulsing gently until the reader has taken or
 * dismissed a tour once. The "seen" flag is per experiment and per browser;
 * storage can be unavailable, in which case it simply never pulses.
 */
export function TourButton({ id, onStart }: { id: string; onStart: () => void }) {
  const key = `workbench:tour-seen:${id}`;
  const [fresh, setFresh] = useState(false);

  useEffect(() => {
    try {
      setFresh(!window.localStorage.getItem(key));
    } catch {
      setFresh(false);
    }
  }, [key]);

  return (
    <Button
      size="xs"
      onClick={() => {
        try {
          window.localStorage.setItem(key, "1");
        } catch {
          // Private windows and blocked storage: the pulse just recurs.
        }
        setFresh(false);
        onStart();
      }}
      animation={fresh ? "pulse 2s ease-in-out infinite" : undefined}
      _motionReduce={{ animation: "none" }}
    >
      ▶ Take the 1-minute tour
    </Button>
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
