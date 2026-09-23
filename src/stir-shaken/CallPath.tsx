"use client";

import { Box, Button, Flex, Text, Wrap } from "@chakra-ui/react";
import { useEffect, useState } from "react";

export type FlightKind = "send" | "tamper" | "replay";
export type Flight = { id: number; kind: FlightKind };
export type Delivery = { tone: "pass" | "fail" | "warn"; title: string; detail: string };

const NODES = [
  { title: "Originating carrier", role: "signs the token" },
  { title: "The network", role: "carries the SIP INVITE" },
  { title: "Terminating carrier", role: "checks it" },
] as const;

const TONE = {
  pass: { color: "green.fg", border: "green.solid", mark: "✓" },
  fail: { color: "red.fg", border: "red.solid", mark: "✗" },
  warn: { color: "orange.fg", border: "orange.solid", mark: "!" },
};

/** Milliseconds per hop. Two hops: signer to network, network to verifier. */
const HOP_MS = 700;

function reducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * A call's journey, drawn: the token leaves the carrier that signed it,
 * crosses the network — where it can be edited — and arrives at the carrier
 * that checks it. The verdict is the host's to compute, from the same checks
 * the rest of the page runs; this component only moves the token and says
 * when it has arrived.
 */
export function CallPath({
  flight,
  delivery,
  tampered,
  onSend,
  onArrive,
}: {
  /** The call in flight, or null. A new id starts a new journey. */
  flight: Flight | null;
  /** What the terminating carrier concluded, once the token has arrived. */
  delivery: Delivery | null;
  /** The number was edited in transit: from → to. */
  tampered: { from: string; to: string } | null;
  onSend: (kind: FlightKind) => void;
  onArrive: () => void;
}) {
  // 0: at the signer, 1: in the network, 2: arrived.
  const [hop, setHop] = useState(0);

  useEffect(() => {
    if (!flight) {
      setHop(0);
      return;
    }
    const step = reducedMotion() ? 0 : HOP_MS;
    setHop(0);
    const timers = [
      // A frame at the start so the chip is drawn at the signer before it
      // moves; otherwise the transition has nothing to animate from.
      setTimeout(() => setHop(1), 30),
      setTimeout(() => setHop(2), 30 + step),
      setTimeout(onArrive, 30 + step * 2),
    ];
    return () => timers.forEach(clearTimeout);
    // A new journey per id; onArrive changing identity must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flight?.id]);

  const editedHere = flight?.kind === "tamper" && hop >= 1;
  const arrived = flight !== null && hop >= 2 && delivery !== null;
  const tone = arrived && delivery ? TONE[delivery.tone] : null;

  return (
    <Box>
      <Text fontSize="xs" fontWeight="bold">
        The call&rsquo;s path
      </Text>
      <Text fontSize="2xs" color="fg.muted" mt="1" lineHeight="short">
        The originating carrier signs a token with its private key; the
        terminating carrier checks it with the matching certificate. Anyone in
        between can read it, and can change it — but not re-sign it.
      </Text>

      <Box position="relative" mt="5" mb="2" aria-hidden>
        {/* The wire */}
        <Box position="absolute" top="3" insetStart="12%" insetEnd="12%" h="2px" bg="border" />
        {/* The token, until the verdict takes its place at the far node. */}
        {flight && !arrived && (
          <Box
            position="absolute"
            top="1.5"
            insetStart={`calc(${12 + hop * 38}% - 2.25rem)`}
            w="4.5rem"
            textAlign="center"
            transition={`inset-inline-start ${HOP_MS}ms ease-in-out`}
            _motionReduce={{ transition: "none" }}
            zIndex="1"
          >
            <Text
              as="span"
              display="inline-block"
              px="1.5"
              py="0.5"
              rounded="full"
              fontSize="9px"
              fontWeight="bold"
              bg={editedHere ? "red.solid" : "colorPalette.solid"}
              color={editedHere ? "red.contrast" : "colorPalette.contrast"}
              transition="background 200ms ease"
            >
              {editedHere ? "✎ edited" : "🔒 token"}
            </Text>
          </Box>
        )}
        <Flex justify="space-between" position="relative">
          {NODES.map((node, i) => {
            const reached = flight !== null && hop >= i;
            const last = i === NODES.length - 1;
            return (
              <Box key={node.title} w="24%" textAlign="center">
                <Box
                  mx="auto"
                  boxSize="6"
                  rounded="full"
                  borderWidth="2px"
                  borderColor={last && tone ? tone.border : reached ? "colorPalette.solid" : "border"}
                  bg="bg.panel"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  fontSize="xs"
                  fontWeight="bold"
                  color={last && tone ? tone.color : "fg.muted"}
                  transition="border-color 200ms ease"
                >
                  {last && tone ? tone.mark : i + 1}
                </Box>
                <Text fontSize="2xs" fontWeight="bold" mt="2" lineHeight="short">
                  {node.title}
                </Text>
                <Text fontSize="9px" color="fg.muted" lineHeight="short">
                  {i === 1 && flight?.kind === "tamper" ? "…where the number is changed" : node.role}
                </Text>
              </Box>
            );
          })}
        </Flex>
      </Box>

      <Wrap gap="2" mt="4">
        <Button size="2xs" onClick={() => onSend("send")}>
          ▶ Send the call
        </Button>
        <Button size="2xs" variant="outline" onClick={() => onSend("tamper")}>
          Change the caller&rsquo;s number in transit
        </Button>
        <Button size="2xs" variant="outline" onClick={() => onSend("replay")}>
          Replay it later
        </Button>
      </Wrap>

      <Box minH="10" mt="3" aria-live="polite">
        {tampered && flight?.kind === "tamper" && hop >= 1 && (
          <Text fontSize="2xs" color="red.fg" fontFamily="mono">
            orig.tn {tampered.from} → {tampered.to}
          </Text>
        )}
        {arrived && delivery && tone && (
          <Box
            mt="1"
            ps="3"
            borderStartWidth="2px"
            borderColor={tone.border}
            animation="fade-in 250ms ease-out"
            _motionReduce={{ animation: "none" }}
          >
            <Text fontSize="xs" fontWeight="bold" color={tone.color}>
              {tone.mark} {delivery.title}
            </Text>
            <Text fontSize="2xs" color="fg.muted" lineHeight="short">
              {delivery.detail}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
