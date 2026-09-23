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
import { useEffect, useMemo, useState } from "react";
import { SAMPLES, SAMPLE_CERTIFICATE } from "./fixtures";
import {
  type Severity,
  ATTESTATIONS,
  analyse,
  parseIdentity,
  tally,
} from "./model";
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

  const parsed = useMemo(() => parseIdentity(raw), [raw]);
  const sections = useMemo(() => analyse(parsed), [parsed]);
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
    <Box>
      {/* Verdict. The signature counts as a check here, not as a separate
          result — a token that fails it has failed, whatever else is in order,
          and a headline reading "all passed" beside a dead signature would be
          the most misleading thing on the page. */}
      <Flex align="baseline" gap="3" wrap="wrap">
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
          </Text>
        </Box>
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

      {/* Samples */}
      <Wrap gap="2" mt="5">
        {SAMPLES.map((sample) => (
          <Button
            key={sample.id}
            size="2xs"
            variant={active === sample.id ? "solid" : "outline"}
            onClick={() => {
              setActive(sample.id);
              setRaw(sample.identity);
              setFetchState(null);
            }}
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
        }}
      />
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
        <Box mt="6" pt="5" borderTopWidth="1px" borderColor="border">
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
    </Box>
  );
}
