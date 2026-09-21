"use client";

import { Box, Flex, HStack, Table, Text } from "@chakra-ui/react";
import { useState } from "react";
import {
  type Budget,
  type Stage,
  STAGES,
  THRESHOLDS,
  ms,
  ticks,
  total,
} from "./model";
import { inkVar, seriesVar } from "./palette";

export type Row = {
  id: string;
  name: string;
  budget: Budget;
  /** The reader's own configuration, drawn first and labelled in bold. */
  own?: boolean;
};

type Hovered = { row: string; stage: Stage; value: number; centre: number } | null;

const BAR_H = "18px";
/**
 * Below this share of the axis an inline label cannot fit. It is a share
 * rather than a pixel width because the track has no fixed size — paired with
 * hiding the labels outright on narrow screens, where even a large share is
 * only a few dozen pixels.
 */
const LABEL_MIN_SHARE = 0.11;

/** Gridlines and the threshold marker, drawn behind one row's bar. */
function Rules({ max, step }: { max: number; step: number }) {
  return (
    <Box position="absolute" inset="0" aria-hidden>
      {ticks(max, step).map((t) => (
        <Box
          key={t}
          position="absolute"
          top="0"
          bottom="0"
          insetStart={`${(t / max) * 100}%`}
          w="1px"
          bg="border"
        />
      ))}
    </Box>
  );
}

/**
 * The threshold annotation, drawn *over* the bars.
 *
 * Behind them it disappears on every row whose bar reaches past it — which is
 * precisely the set of rows it exists to comment on. Dashed, so it never reads
 * as another grid step.
 */
function Thresholds({ max }: { max: number }) {
  return (
    <Box position="absolute" inset="0" zIndex="1" pointerEvents="none" aria-hidden>
      {THRESHOLDS.filter((t) => t.at < max).map((t) => (
        <Box
          key={t.label}
          position="absolute"
          top="0"
          bottom="0"
          insetStart={`${(t.at / max) * 100}%`}
          borderStartWidth="1px"
          borderStyle="dashed"
          borderColor="fg"
          opacity="0.55"
        />
      ))}
    </Box>
  );
}

/**
 * One configuration as a stacked bar on a shared time axis.
 *
 * Segments are absolutely positioned rather than laid out with a flex gap: the
 * 2px separator has to come out of the segment's own width, or seven gaps of
 * accumulated error would make two rows with the same total end at different
 * places.
 */
function Bar({
  row,
  max,
  step,
  onHover,
  hovered,
}: {
  row: Row;
  max: number;
  step: number;
  onHover: (h: Hovered) => void;
  hovered: Hovered;
}) {
  const values = STAGES.map((stage) => row.budget[stage.id]);
  const segments = STAGES.map((stage, i) => ({
    stage,
    value: values[i],
    // Prefix sum rather than a running total, so nothing is reassigned while
    // the component renders. Seven elements — the extra passes are free.
    start: values.slice(0, i).reduce((a, b) => a + b, 0),
    colour: seriesVar(i),
    ink: inkVar(i),
  })).filter((s) => s.value > 0);

  const sum = total(row.budget);

  return (
    <Box position="relative" h={BAR_H}>
      <Rules max={max} step={step} />

      {segments.map((s, i) => {
        const share = s.value / max;
        const isLast = i === segments.length - 1;
        const active = hovered?.row === row.id && hovered.stage.id === s.stage.id;
        const enter = () =>
          onHover({
            row: row.id,
            stage: s.stage,
            value: s.value,
            centre: ((s.start + s.value / 2) / max) * 100,
          });

        return (
          <Box
            key={s.stage.id}
            as="button"
            aria-label={`${row.name}, ${s.stage.label}: ${ms(s.value)}`}
            position="absolute"
            top="0"
            bottom="0"
            insetStart={`${(s.start / max) * 100}%`}
            // The 2px separator is the surface showing through, not a stroke
            // drawn on the mark.
            width={`max(1px, calc(${share * 100}% - 2px))`}
            bg={s.colour}
            opacity={hovered && !active ? 0.55 : 1}
            transition="opacity 120ms ease"
            borderEndRadius={isLast ? "4px" : "0"}
            cursor="default"
            _focusVisible={{
              outline: "2px solid",
              outlineColor: "colorPalette.solid",
              outlineOffset: "2px",
            }}
            onMouseEnter={enter}
            onFocus={enter}
            onMouseLeave={() => onHover(null)}
            onBlur={() => onHover(null)}
          >
            {row.own && share >= LABEL_MIN_SHARE && (
              <Text
                as="span"
                // Hidden on narrow screens: a share that is comfortable on a
                // 600px track is 25px on a phone, and a clipped label is worse
                // than none. The legend and the table carry it either way.
                hideBelow="md"
                px="1.5"
                fontSize="9px"
                lineHeight={BAR_H}
                fontWeight="bold"
                letterSpacing="wide"
                whiteSpace="nowrap"
                overflow="hidden"
                // Inside a filled mark, so the ink is picked against the fill
                // rather than from the page's text tokens.
                color={s.ink}
                textAlign="center"
                display="block"
              >
                {s.stage.short}
              </Text>
            )}
          </Box>
        );
      })}

      <Thresholds max={max} />

      {/* Total at the data end — the one direct label every row carries. */}
      <Text
        position="absolute"
        insetStart={`calc(${(sum / max) * 100}% + 8px)`}
        top="0"
        lineHeight={BAR_H}
        fontSize="2xs"
        fontWeight={row.own ? "bold" : "normal"}
        color={row.own ? "fg" : "fg.muted"}
        whiteSpace="nowrap"
        fontVariantNumeric="tabular-nums"
      >
        {ms(sum)}
      </Text>
    </Box>
  );
}

export function BudgetChart({
  rows,
  max,
  step,
}: {
  rows: Row[];
  max: number;
  step: number;
}) {
  const [hovered, setHovered] = useState<Hovered>(null);

  return (
    // The right gutter holds the total labels, which the track would otherwise
    // clip at full width.
    <Box position="relative" pe="14" mt="5">
      {/* Threshold captions, above the plot so they never cross a bar or a
          row name. */}
      <Box position="relative" h="5" aria-hidden>
        {THRESHOLDS.filter((t) => t.at < max).map((t) => (
          <Text
            key={t.label}
            position="absolute"
            insetStart={`${(t.at / max) * 100}%`}
            ms="1"
            fontSize="9px"
            color="fg.muted"
            whiteSpace="nowrap"
          >
            {t.label}
          </Text>
        ))}
      </Box>

      <Box position="relative">
        {rows.map((row) => (
          <Box key={row.id} mb="3">
            <Text
              fontSize="2xs"
              mb="1"
              fontWeight={row.own ? "bold" : "normal"}
              color={row.own ? "fg" : "fg.muted"}
            >
              {row.name}
            </Text>
            <Bar
              row={row}
              max={max}
              step={step}
              onHover={setHovered}
              hovered={hovered}
            />
          </Box>
        ))}

        {/* Tooltip. Anchored to the hovered segment's centre; the same box is
            shown on keyboard focus, so nothing is hover-only. */}
        {hovered && (
          <Box
            position="absolute"
            top="0"
            insetStart={`${hovered.centre}%`}
            transform="translate(-50%, -100%)"
            pointerEvents="none"
            zIndex="1"
            bg="bg"
            borderWidth="1px"
            borderColor="border"
            rounded="l2"
            shadow="md"
            px="3"
            py="2"
            maxW="56"
            w="max-content"
          >
            <Text fontSize="2xs" fontWeight="bold">
              {hovered.stage.label}
            </Text>
            <Text
              fontSize="2xs"
              color="colorPalette.fg"
              fontVariantNumeric="tabular-nums"
            >
              {ms(hovered.value)}
            </Text>
            <Text fontSize="9px" color="fg.muted" mt="1" lineHeight="short">
              {hovered.stage.note}
            </Text>
          </Box>
        )}
      </Box>

      {/* Axis */}
      <Box position="relative" h="5" borderTopWidth="1px" borderColor="border">
        {ticks(max, step).map((t) => (
          <Text
            key={t}
            position="absolute"
            insetStart={`${(t / max) * 100}%`}
            transform="translateX(-50%)"
            pt="1"
            fontSize="9px"
            color="fg.muted"
            fontVariantNumeric="tabular-nums"
          >
            {t}
          </Text>
        ))}
        <Text position="absolute" insetEnd="-10" pt="1" fontSize="9px" color="fg.muted">
          ms
        </Text>
      </Box>
    </Box>
  );
}

/** Always present: identity never rests on the fill colour alone. */
export function Legend({ budget }: { budget: Budget }) {
  return (
    <Flex wrap="wrap" columnGap="4" rowGap="1.5" mt="3">
      {STAGES.map((stage, i) => (
        <HStack key={stage.id} gap="1.5">
          <Box boxSize="2.5" rounded="2px" bg={seriesVar(i)} flexShrink="0" />
          <Text fontSize="2xs" color="fg.muted">
            {stage.label}
          </Text>
          <Text fontSize="2xs" fontVariantNumeric="tabular-nums">
            {ms(budget[stage.id])}
          </Text>
        </HStack>
      ))}
    </Flex>
  );
}

/** The WCAG-clean twin of the chart — every value, no colour required. */
export function BudgetTable({ rows }: { rows: Row[] }) {
  return (
    <Box overflowX="auto">
      <Table.Root size="sm" variant="outline" mt="3" fontSize="2xs">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader fontSize="2xs">Stage</Table.ColumnHeader>
            {rows.map((row) => (
              <Table.ColumnHeader key={row.id} textAlign="end" fontSize="2xs">
                {row.name}
              </Table.ColumnHeader>
            ))}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {STAGES.map((stage) => (
            <Table.Row key={stage.id}>
              <Table.Cell color="fg.muted" whiteSpace="nowrap">
                {stage.label}
              </Table.Cell>
              {rows.map((row) => (
                <Table.Cell
                  key={row.id}
                  textAlign="end"
                  fontVariantNumeric="tabular-nums"
                >
                  {ms(row.budget[stage.id])}
                </Table.Cell>
              ))}
            </Table.Row>
          ))}
          <Table.Row fontWeight="bold">
            <Table.Cell whiteSpace="nowrap">Response latency</Table.Cell>
            {rows.map((row) => (
              <Table.Cell
                key={row.id}
                textAlign="end"
                fontVariantNumeric="tabular-nums"
              >
                {ms(total(row.budget))}
              </Table.Cell>
            ))}
          </Table.Row>
        </Table.Body>
      </Table.Root>
    </Box>
  );
}
