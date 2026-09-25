"use client";

import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Heading,
  SimpleGrid,
  Text,
  Textarea,
  Wrap,
} from "@chakra-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SAMPLES, SAMPLE_CERTIFICATE } from "./fixtures";
import {
  type Severity,
  ATTESTATIONS,
  FRESHNESS_SECONDS,
  analyse,
  formatAge,
  parseIdentity,
  tally,
  tamperPayload,
} from "./model";
import { CallPath, type Delivery, type Flight, type FlightKind } from "./CallPath";
import {
  Tour,
  TourButton,
  type TourStep,
  clearTourHash,
  tourFromHash,
  tourSpotlight,
} from "../shared/Tour";
import { hasTnAuthList, pemToDer, verifySignature, type Verification } from "./crypto";

const TONE: Record<Severity, { color: string; mark: string; label: string }> = {
  pass: { color: "green.fg", mark: "✓", label: "pass" },
  fail: { color: "red.fg", mark: "✗", label: "fail" },
  warn: { color: "orange.fg", mark: "!", label: "warning" },
  info: { color: "fg.muted", mark: "·", label: "note" },
};

/** Severity never rests on colour alone: a mark and a word ride with it. */
function Mark({ severity }: { severity: Severity }) {
  const tone = TONE[severity];
  return (
    <Text
      as="span"
      aria-label={tone.label}
      color={tone.color}
      fontWeight="bold"
      fontFamily="mono"
      flexShrink="0"
      w="3"
      textAlign="center"
    >
      {tone.mark}
    </Text>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <Text as="code" fontFamily="mono" fontSize="0.92em">
      {children}
    </Text>
  );
}

export default function StirShaken() {
  const [raw, setRaw] = useState(SAMPLES[0].identity);
  const [active, setActive] = useState(SAMPLES[0].id);
  const [certificate, setCertificate] = useState(SAMPLE_CERTIFICATE);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [fetchState, setFetchState] = useState<string | null>(null);

  // Which clock the checks run against. "now" is the real time, which is
  // right for a pasted token. A call sent along the path below is checked as
  // if it arrived two seconds after it was signed — except a replay, which is
  // the same token arriving now, and is exactly what the freshness rule
  // exists to catch.
  const [clock, setClock] = useState<"now" | "signing">("now");
  const [flight, setFlight] = useState<Flight | null>(null);
  const [arrived, setArrived] = useState(false);
  const [tampered, setTampered] = useState<{ from: string; to: string } | null>(null);

  // Guided tour state: the step, and which steps' calls have arrived.
  const [tourIndex, setTourIndex] = useState<number | null>(null);
  const tourRef = useRef<number | null>(null);
  tourRef.current = tourIndex;
  const [delivered, setDelivered] = useState<Record<number, boolean>>({});
  const root = useRef<HTMLDivElement>(null);

  const parsed = useMemo(() => parseIdentity(raw), [raw]);
  const iat = typeof parsed.claims?.iat === "number" ? (parsed.claims.iat as number) : null;
  const checkedAt = clock === "signing" && iat !== null ? (iat + 2) * 1000 : Date.now();
  const sections = useMemo(() => analyse(parsed, checkedAt), [parsed, checkedAt]);
  const counts = useMemo(() => tally(sections), [sections]);

  const attest =
    typeof parsed.claims?.attest === "string"
      ? ATTESTATIONS[parsed.claims.attest as string]
      : undefined;

  // Re-verify whenever the token or the certificate changes, rather than
  // leaving a stale verdict on screen next to new input.
  useEffect(() => {
    let cancelled = false;
    if (!parsed.parts.signature || !certificate.trim()) {
      setVerification(null);
      return;
    }
    void verifySignature(
      `${parsed.parts.header}.${parsed.parts.payload}`,
      parsed.parts.signature,
      certificate,
    ).then((result) => {
      if (!cancelled) setVerification(result);
    });
    return () => {
      cancelled = true;
    };
  }, [parsed, certificate]);

  const tnAuth = useMemo(() => {
    try {
      return hasTnAuthList(pemToDer(certificate));
    } catch {
      return false;
    }
  }, [certificate]);

  const signatureFailed = verification?.state === "invalid";
  const failed = counts.failed + (signatureFailed ? 1 : 0);
  const total = counts.total + (verification && verification.state !== "error" ? 1 : 0);

  const x5u = typeof parsed.header?.x5u === "string" ? parsed.header.x5u : null;

  /** Load a sample, discarding any call in flight. */
  const choose = (id: string) => {
    const sample = SAMPLES.find((s) => s.id === id);
    if (!sample) return;
    setActive(sample.id);
    setRaw(sample.identity);
    setFetchState(null);
    setTampered(null);
    setFlight(null);
    setArrived(false);
    setClock("now");
  };

  /**
   * Send the current token along the path. "tamper" edits the caller's
   * number on the way, starting from the genuine sample if the token on
   * screen is not one; "replay" checks it against the real clock.
   */
  const send = (kind: FlightKind, base?: string) => {
    let token = base ?? raw;
    if (base) {
      const sample = SAMPLES.find((s) => s.identity === base);
      setActive(sample?.id ?? "");
    }
    if (kind === "tamper") {
      const orig = (parseIdentity(token).claims?.orig as { tn?: unknown } | undefined)?.tn;
      if (typeof orig === "string" && orig.length > 4) {
        const to = `${orig.slice(0, -4)}0000`;
        const forged = tamperPayload(token, `"${orig}"`, `"${to}"`);
        if (forged) {
          token = forged;
          setTampered({ from: orig, to });
          setActive("");
        }
      }
    } else {
      setTampered(null);
    }
    setRaw(token);
    setClock(kind === "replay" ? "now" : "signing");
    setArrived(false);
    setFlight((prev) => ({ id: (prev?.id ?? 0) + 1, kind }));
  };

  const onArrive = () => {
    setArrived(true);
    const at = tourRef.current;
    if (at !== null) setDelivered((prev) => ({ ...prev, [at]: true }));
  };

  // The terminating carrier's verdict, from the very checks listed below.
  const timeCheck = sections.find((s) => s.title === "Time")?.checks[0];
  const firstFailure = sections.flatMap((s) => s.checks).find((c) => c.severity === "fail");
  let delivery: Delivery | null = null;
  if (arrived && verification) {
    if (verification.state === "invalid") {
      delivery = {
        tone: "fail",
        title: "Rejected: the signature does not verify",
        detail:
          "The bytes that arrived are not the bytes that were signed. Without the originating carrier's private key there is no way to sign the new ones.",
      };
    } else if (firstFailure) {
      delivery = {
        tone: "fail",
        title: `Rejected: ${firstFailure.label}`,
        detail: `${firstFailure.detail}${firstFailure.spec ? ` (${firstFailure.spec})` : ""}`,
      };
    } else if (timeCheck?.severity === "warn") {
      delivery = {
        tone: "warn",
        title: "Signature valid, but the token is old: a replay",
        detail: timeCheck.detail,
      };
    } else {
      delivery = {
        tone: "pass",
        title: `Verified · attestation ${attest?.level ?? "?"}`,
        detail: attest ? attest.means : "The signature verifies and every structural rule holds.",
      };
    }
  }

  const replayAge = iat !== null ? formatAge(Math.round(Date.now() / 1000 - iat)) : null;
  const valid = SAMPLES.find((s) => s.id === "valid")!.identity;
  const sampleOf = (id: string) => SAMPLES.find((s) => s.id === id)!.identity;

  const steps: TourStep[] = [
    {
      target: "verdict",
      say: "Calls in the US and Canada are meant to carry a signed token saying who is calling and how sure the caller's own carrier is of it. This tour sends a few, and tampers with some on the way.",
    },
    {
      target: "path",
      say: "First, an honest call: the originating carrier signs it and the terminating carrier checks it.",
      showLabel: "Send it",
      show: () => send("send", valid),
      done: !!delivered[1],
      after: "The signature verifies and the attestation is A: the carrier knows this customer and has confirmed their right to the number.",
    },
    {
      target: "path",
      say: "Now intercept the same call in the network and change the caller's number, the way a spoofer would.",
      showLabel: "Change the number",
      show: () => send("tamper", valid),
      done: !!delivered[2] && delivery?.tone === "fail",
      after: "Every structural rule still holds; only the signature fails. Changing one digit changes the bytes, and signing the new bytes needs a private key the spoofer does not have.",
    },
    {
      target: "attestation",
      say: "A signature proves who signed, not who is calling. Send a call signed at the lowest level of trust.",
      showLabel: "Send a C call",
      show: () => send("send", sampleOf("gateway")),
      done: !!delivered[3],
      after: "Valid signature, attestation C: the carrier is honestly saying it cannot vouch for the caller. This is how a spoofed number can still arrive fully signed.",
    },
    {
      target: "path",
      say: "Last trick: record a genuine token and send it again later, with a different call.",
      showLabel: "Replay it",
      show: () => send("replay", valid),
      done: !!delivered[4],
      after: `The signature still verifies: a copy of a genuine token is still genuine. Only its age gives it away. It was signed ${replayAge ?? "long"} ago, and verifiers allow ${FRESHNESS_SECONDS} seconds.`,
    },
    {
      target: "checks",
      say: "Beyond the signature, the receiver checks the token's shape against the standards. Send one whose claims are in the wrong order.",
      showLabel: "Send it",
      show: () => send("send", sampleOf("unordered")),
      done: !!delivered[5],
      after: "The signature is fine, but RFC 8225 fixes the order of the claims so every verifier hashes the same bytes. A strict verifier rejects it; the list below names the rule and its section.",
    },
    {
      target: "input",
      say: "Paste an Identity header from your own SIP traces to inspect it the same way. It never leaves your browser.",
    },
  ];

  const startTour = () => {
    setDelivered({});
    setTourIndex(0);
  };
  const closeTour = () => {
    setTourIndex(null);
    clearTourHash();
  };
  useEffect(() => {
    const at = tourFromHash();
    if (at !== null) setTourIndex(Math.max(0, Math.min(6, at)));
  }, []);

  async function tryFetch() {
    if (!x5u) return;
    setFetchState("fetching…");
    try {
      const response = await fetch(x5u, { mode: "cors" });
      setFetchState(`${response.status} ${response.statusText}`);
    } catch {
      setFetchState("blocked");
    }
  }

  return (
    <Box
      ref={root}
      css={tourSpotlight(tourIndex !== null ? steps[tourIndex] : null)}
    >
      {/* Verdict. The signature counts as a check here, not as a separate
          result — a token that fails it has failed, whatever else is in order,
          and a headline reading "all passed" beside a dead signature would be
          the most misleading thing on the page. */}
      <Flex align="baseline" gap="3" wrap="wrap" data-tour="verdict">
        <Text
          fontSize={{ base: "4xl", sm: "5xl" }}
          fontWeight="bold"
          lineHeight="1"
          color={failed > 0 ? "red.fg" : "green.fg"}
        >
          {failed > 0 ? `${failed} failed` : "All passed"}
        </Text>
        <Box>
          <Text fontSize="xs" fontWeight="bold">
            {total} checks
          </Text>
          <Text fontSize="2xs" color="fg.muted">
            {counts.warned > 0
              ? `${counts.warned} warning${counts.warned > 1 ? "s" : ""}`
              : "no warnings"}
            {signatureFailed ? " · signature does not verify" : ""}
            {clock === "signing" ? " · checked as received 2 s after signing" : ""}
          </Text>
        </Box>
        {tourIndex === null && (
          <Box ms="auto">
            <TourButton id="stir-shaken" onStart={startTour} />
          </Box>
        )}
      </Flex>

      <Box mt="5" ps="3" borderStartWidth="2px" borderColor="colorPalette.solid">
        <Text fontSize="2xs" color="fg.muted" lineHeight="tall">
          Paste the <Code>Identity</Code> header from a SIP INVITE and this pulls
          it apart: the PASSporT is decoded, every structural rule in RFC 8224,
          8225 and 8588 is checked, and the signature is verified against a
          certificate using ECDSA in your browser.{" "}
          <Text as="span" color="fg">
            Nothing is uploaded
          </Text>{" "}
          — no token, no certificate, no key.
        </Text>
        <Text fontSize="2xs" color="fg.muted" mt="2" lineHeight="tall">
          The samples below are signed with a real P-256 key, so the signature
          check is doing real work. Try{" "}
          <Text as="span" color="fg">
            Attestation upgraded after signing
          </Text>{" "}
          to watch a structurally perfect token fail on the only check that
          cannot be forged.
        </Text>
      </Box>

      {/* The call's path */}
      <Box data-tour="path" mt="6" p="4" borderWidth="1px" borderColor="border" rounded="l3">
        <CallPath
          flight={flight}
          delivery={delivery}
          tampered={tampered}
          onSend={(kind) => send(kind)}
          onArrive={onArrive}
        />
      </Box>

      {/* Samples */}
      <Box data-tour="input">
        <Wrap gap="2" mt="5">
          {SAMPLES.map((sample) => (
            <Button
              key={sample.id}
              size="2xs"
              variant={active === sample.id ? "solid" : "outline"}
              onClick={() => choose(sample.id)}
            >
              {sample.label}
            </Button>
          ))}
        </Wrap>
        <Text fontSize="2xs" color="fg.muted" mt="2" minH="4" lineHeight="short">
          {SAMPLES.find((s) => s.id === active)?.note}
        </Text>

        <Textarea
          mt="4"
          rows={4}
          fontFamily="mono"
          fontSize="2xs"
          value={raw}
          spellCheck={false}
          aria-label="SIP Identity header"
          onChange={(event) => {
            setRaw(event.target.value);
            setActive("");
            setTampered(null);
            setFlight(null);
            setArrived(false);
            setClock("now");
          }}
        />
      </Box>
      {parsed.error && (
        <HStack mt="2" gap="2" align="start">
          <Mark severity="fail" />
          <Text fontSize="2xs" color="red.fg">
            {parsed.error}
          </Text>
        </HStack>
      )}

      {/* Attestation */}
      {attest && (
        <Flex
          data-tour="attestation"
          mt="6"
          gap="4"
          align="flex-start"
          borderWidth="1px"
          borderColor="border"
          rounded="l3"
          p="4"
        >
          <Text
            fontSize="4xl"
            fontWeight="bold"
            lineHeight="1"
            color="colorPalette.fg"
            flexShrink="0"
          >
            {attest.level}
          </Text>
          <Box minW="0">
            <Text fontSize="sm" fontWeight="bold">
              {attest.name}
            </Text>
            <Text fontSize="2xs" color="fg.muted" mt="1.5" lineHeight="tall">
              {attest.means}
            </Text>
            <Text fontSize="2xs" mt="2" lineHeight="tall">
              <Text as="span" fontWeight="bold">
                What it does not mean:
              </Text>{" "}
              <Text as="span" color="fg.muted">
                {attest.doesNotMean}
              </Text>
            </Text>
          </Box>
        </Flex>
      )}

      {/* Signature */}
      <Box mt="6" pt="5" borderTopWidth="1px" borderColor="border">
        <Flex justify="space-between" align="baseline" gap="4" wrap="wrap">
          <Text fontSize="xs" fontWeight="bold">
            Signature
          </Text>
          {verification && (
            <HStack gap="2">
              <Mark
                severity={
                  verification.state === "valid"
                    ? "pass"
                    : verification.state === "invalid"
                      ? "fail"
                      : "warn"
                }
              />
              <Text
                fontSize="xs"
                fontWeight="bold"
                color={
                  verification.state === "valid"
                    ? "green.fg"
                    : verification.state === "invalid"
                      ? "red.fg"
                      : "orange.fg"
                }
              >
                {verification.state === "valid"
                  ? "verified"
                  : verification.state === "invalid"
                    ? "does not verify"
                    : verification.message}
              </Text>
            </HStack>
          )}
        </Flex>
        <Text fontSize="2xs" color="fg.muted" mt="1" lineHeight="short">
          ECDSA P-256 over SHA-256, run by WebCrypto against the certificate
          below. JOSE carries the signature as raw R‖S rather than the DER form
          OpenSSL prints, which is the usual reason a hand-rolled verifier says
          no to a perfectly good token.
        </Text>

        <SimpleGrid columns={{ base: 1, md: 2 }} gap="4" mt="4">
          <Box>
            <Text fontSize="2xs" color="fg.muted" mb="1.5">
              Certificate (PEM)
            </Text>
            <Textarea
              rows={6}
              fontFamily="mono"
              fontSize="9px"
              value={certificate}
              spellCheck={false}
              aria-label="Signing certificate in PEM form"
              onChange={(event) => setCertificate(event.target.value)}
            />
            <HStack mt="2" gap="2">
              <Badge size="xs" variant="subtle" colorPalette={tnAuth ? "green" : "orange"}>
                {tnAuth ? "TNAuthList present" : "no TNAuthList"}
              </Badge>
              <Button
                size="2xs"
                variant="ghost"
                onClick={() => setCertificate(SAMPLE_CERTIFICATE)}
              >
                Reset
              </Button>
            </HStack>
          </Box>

          <Box>
            <Text fontSize="2xs" color="fg.muted" mb="1.5">
              Fetching the certificate from x5u
            </Text>
            <Text fontSize="2xs" color="fg.muted" lineHeight="tall">
              A real verifier fetches the signer&rsquo;s certificate from the{" "}
              <Code>x5u</Code> URL. A browser mostly cannot: certificate
              repositories serve no CORS headers, because they were never meant
              for web pages. That is a constraint of doing this in a tab, not a
              flaw in the token.
            </Text>
            <Text fontSize="2xs" color="fg.muted" lineHeight="tall" mt="1.5">
              This button is the only thing on the page that contacts another
              server. It requests the token&rsquo;s <Code>x5u</Code> URL;
              nothing else you have pasted is sent.
            </Text>
            <HStack mt="3" gap="2">
              <Button size="2xs" variant="outline" onClick={() => void tryFetch()} disabled={!x5u}>
                Try it anyway
              </Button>
              {fetchState && (
                <Text fontSize="2xs" color="fg.muted" fontFamily="mono">
                  {fetchState}
                </Text>
              )}
            </HStack>
          </Box>
        </SimpleGrid>
      </Box>

      {/* Checks */}
      {sections.length > 0 && (
        <Box mt="6" pt="5" borderTopWidth="1px" borderColor="border" data-tour="checks">
          <Text fontSize="xs" fontWeight="bold">
            Checks
          </Text>
          <SimpleGrid columns={{ base: 1, md: 2 }} gap="5" mt="4">
            {sections.map((section) => (
              <Box key={section.title}>
                <Text
                  fontSize="2xs"
                  fontWeight="bold"
                  textTransform="uppercase"
                  letterSpacing="wider"
                  color="fg.muted"
                >
                  {section.title}
                </Text>
                <Box mt="2">
                  {section.checks.map((check) => (
                    <Flex key={check.id} gap="2" align="flex-start" mb="2">
                      <Mark severity={check.severity} />
                      <Box minW="0">
                        <Flex gap="2" align="baseline" wrap="wrap">
                          <Text fontSize="2xs" fontWeight="bold">
                            {check.label}
                          </Text>
                          {check.spec && (
                            <Text fontSize="9px" color="fg.muted">
                              {check.spec}
                            </Text>
                          )}
                        </Flex>
                        <Text
                          fontSize="2xs"
                          color="fg.muted"
                          lineHeight="short"
                          wordBreak="break-word"
                        >
                          {check.detail}
                        </Text>
                      </Box>
                    </Flex>
                  ))}
                </Box>
              </Box>
            ))}
          </SimpleGrid>
        </Box>
      )}

      {/* Decoded */}
      {parsed.header && parsed.claims && (
        <Box mt="6" pt="5" borderTopWidth="1px" borderColor="border">
          <Text fontSize="xs" fontWeight="bold">
            Decoded
          </Text>
          <SimpleGrid columns={{ base: 1, md: 2 }} gap="4" mt="3">
            {[
              { title: "JOSE header", body: parsed.headerText },
              { title: "Claims", body: parsed.claimsText },
            ].map((pane) => (
              <Box key={pane.title}>
                <Text fontSize="2xs" color="fg.muted" mb="1.5">
                  {pane.title}
                </Text>
                <Box
                  as="pre"
                  p="3"
                  rounded="l2"
                  bg="bg.subtle"
                  borderWidth="1px"
                  borderColor="border"
                  fontFamily="mono"
                  fontSize="9px"
                  lineHeight="tall"
                  overflowX="auto"
                >
                  {pane.body}
                </Box>
              </Box>
            ))}
          </SimpleGrid>
          <Text fontSize="9px" color="fg.muted" mt="3" lineHeight="short">
            Claims are shown in the order they were serialized, not sorted — the
            order is itself one of the things being checked.
          </Text>
        </Box>
      )}

      {tourIndex !== null && (
        <Tour
          steps={steps}
          index={tourIndex}
          onIndex={setTourIndex}
          onClose={closeTour}
          root={root.current}
        />
      )}
    </Box>
  );
}
