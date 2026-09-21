"use client";

import { Box, Flex, SegmentGroup, Slider, Text } from "@chakra-ui/react";

/**
 * A labelled slider with its current value read out beside the label, so the
 * number is legible without dragging or hovering the thumb.
 */
export function Knob({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit = "ms",
  hint,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <Box opacity={disabled ? 0.45 : 1} transition="opacity 150ms ease">
      <Slider.Root
        size="sm"
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={(e) => onChange(e.value[0])}
      >
        {/* Slider.Label rather than a bare Text, so the thumb is actually
            labelled for a screen reader instead of only looking labelled. */}
        <Flex justify="space-between" align="baseline" gap="2">
          <Slider.Label fontSize="2xs" color="fg.muted">
            {label}
          </Slider.Label>
          <Text fontSize="2xs" fontWeight="bold" fontVariantNumeric="tabular-nums">
            {value}
            <Text as="span" color="fg.muted" fontWeight="normal">
              {" "}
              {unit}
            </Text>
          </Text>
        </Flex>
        <Slider.Control mt="1.5">
          <Slider.Track>
            <Slider.Range />
          </Slider.Track>
          {/* An explicit single thumb: Slider.Thumbs reads props from a
              provider this composition does not set up, and throws. */}
          <Slider.Thumb index={0}>
            <Slider.HiddenInput />
          </Slider.Thumb>
        </Slider.Control>
      </Slider.Root>
      {hint && (
        <Text fontSize="9px" color="fg.muted" mt="1" lineHeight="short">
          {hint}
        </Text>
      )}
    </Box>
  );
}

/** A segmented choice between a small fixed set of modes. */
export function Choice<T extends string>({
  label,
  value,
  onChange,
  options,
  hint,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  hint?: string;
}) {
  return (
    <Box>
      <Text fontSize="2xs" color="fg.muted" mb="1.5">
        {label}
      </Text>
      <SegmentGroup.Root
        size="xs"
        value={value}
        // Zag reports null when the active item is re-selected; hold the
        // current value rather than dropping to an unset state.
        onValueChange={(e) => onChange((e.value ?? value) as T)}
      >
        <SegmentGroup.Indicator />
        <SegmentGroup.Items items={options} />
      </SegmentGroup.Root>
      {hint && (
        <Text fontSize="9px" color="fg.muted" mt="1" lineHeight="short">
          {hint}
        </Text>
      )}
    </Box>
  );
}
