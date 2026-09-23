/**
 * Parsing and rule-checking for a SHAKEN PASSporT.
 *
 * Pure functions over strings. No React, no network, no WebCrypto — the
 * signature check lives in crypto.ts, because it is the one part that needs a
 * browser API and the one part people most often want to reuse separately.
 *
 * The rules come from three documents, and the tool cites which one every time
 * it complains:
 *
 *   RFC 8224  the SIP Identity header field and its parameters
 *   RFC 8225  PASSporT itself: the JOSE header, the base claims, canonical form
 *   RFC 8588  the "shaken" PASSporT extension: the attest and origid claims
 *
 * with ATIS-1000074 layering the North American profile on top, which is what
 * pins the algorithm to ES256 and defines what A, B and C actually mean.
 */

export type Severity = "pass" | "fail" | "warn" | "info";

export type Check = {
  id: string;
  /** What was examined. */
  label: string;
  severity: Severity;
  /** What was found, in a sentence. */
  detail: string;
  /** Where the rule comes from. */
  spec?: string;
};

export type Section = { title: string; checks: Check[] };

/* ------------------------------------------------------------------ */
/* base64url                                                           */
/* ------------------------------------------------------------------ */

export function b64uToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function b64uToText(input: string): string {
  return new TextDecoder().decode(b64uToBytes(input));
}

function textToB64u(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * What someone in the middle of the network can do to a signed call: edit a
 * claim in the payload, byte for byte where it sits, and pass the rest along
 * untouched — header, signature and Identity parameters included. What they
 * cannot do is re-sign it, which is the whole point.
 *
 * Returns null if `from` does not appear in the payload.
 */
export function tamperPayload(identity: string, from: string, to: string): string | null {
  const [token, ...params] = identity.split(";");
  const [header, payload, signature] = token.trim().split(".");
  if (!header || !payload || !signature) return null;
  const text = b64uToText(payload);
  if (!text.includes(from)) return null;
  const forged = textToB64u(text.replace(from, to));
  return [`${header}.${forged}.${signature}`, ...params].join(";");
}

/** base64url proper: no padding, and none of +, / or whitespace. */
const B64U = /^[A-Za-z0-9_-]+$/;

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

export type Parsed = {
  /** The compact JWS, before the Identity header's parameters. */
  token: string;
  parts: { header: string; payload: string; signature: string };
  /** Parameters off the Identity header field: info, alg, ppt. */
  params: Record<string, string>;
  header: Record<string, unknown> | null;
  claims: Record<string, unknown> | null;
  /** Claim keys in the order they were actually serialized. */
  claimOrder: string[];
  /** Pretty-printed for display, preserving the original key order. */
  headerText: string;
  claimsText: string;
  error?: string;
};

/**
 * Split an Identity header value into its token and parameters.
 *
 * RFC 8224 puts the compact-form PASSporT first, then semicolon-separated
 * parameters — info is an angle-bracketed URI, alg and ppt are bare tokens.
 */
export function parseIdentity(raw: string): Parsed {
  const input = raw.trim().replace(/^Identity\s*:\s*/i, "");
  const [tokenPart, ...paramParts] = input.split(";");
  const token = tokenPart.trim().replace(/\s+/g, "");

  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const at = part.indexOf("=");
    if (at === -1) continue;
    const key = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).trim().replace(/^<|>$/g, "").replace(/^"|"$/g, "");
    params[key] = value;
  }

  const segments = token.split(".");
  const parts = {
    header: segments[0] ?? "",
    payload: segments[1] ?? "",
    signature: segments[2] ?? "",
  };

  const empty: Parsed = {
    token,
    parts,
    params,
    header: null,
    claims: null,
    claimOrder: [],
    headerText: "",
    claimsText: "",
  };

  if (segments.length !== 3 || !parts.header || !parts.payload || !parts.signature) {
    return { ...empty, error: "Not three dot-separated segments." };
  }

  try {
    const headerText = b64uToText(parts.header);
    const claimsText = b64uToText(parts.payload);
    const header = JSON.parse(headerText) as Record<string, unknown>;
    const claims = JSON.parse(claimsText) as Record<string, unknown>;
    return {
      ...empty,
      header,
      claims,
      // Object.keys preserves insertion order for string keys, which is the
      // serialized order — that is exactly what the canonical-form rule is
      // about, so it must not be sorted anywhere before the check runs.
      claimOrder: Object.keys(claims),
      headerText: JSON.stringify(header, null, 2),
      claimsText: JSON.stringify(claims, null, 2),
    };
  } catch {
    return { ...empty, error: "A segment is not base64url-encoded JSON." };
  }
}

/* ------------------------------------------------------------------ */
/* Attestation                                                         */
/* ------------------------------------------------------------------ */

export type Attestation = {
  level: string;
  name: string;
  /** What the originating carrier is asserting. */
  means: string;
  /** The thing people read into it that it does not say. */
  doesNotMean: string;
};

export const ATTESTATIONS: Record<string, Attestation> = {
  A: {
    level: "A",
    name: "Full attestation",
    means:
      "The originating carrier knows who this customer is, and has confirmed that they are entitled to use this specific number.",
    doesNotMean:
      "That the call is wanted, honest, or not a scam. It says the carrier can name the customer if asked — nothing about what that customer is saying.",
  },
  B: {
    level: "B",
    name: "Partial attestation",
    means:
      "The carrier knows who the customer is, but has not verified their right to the number being presented. Typical of a PBX presenting its own range.",
    doesNotMean:
      "That the number is spoofed. It means the carrier did not check, which is a different claim from having checked and found a problem.",
  },
  C: {
    level: "C",
    name: "Gateway attestation",
    means:
      "The carrier put the call on the network but cannot authenticate where it came from — an international gateway, most often.",
    doesNotMean:
      "That the call is fraudulent. Plenty of legitimate international traffic can be attested no higher than this.",
  },
};

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** ATIS-1000074 recommends rejecting a PASSporT older than this. */
export const FRESHNESS_SECONDS = 60;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

function headerChecks(p: Parsed): Check[] {
  const h = p.header ?? {};
  const checks: Check[] = [];

  const typ = str(h.typ);
  checks.push({
    id: "typ",
    label: "typ",
    severity: typ === "passport" ? "pass" : "fail",
    detail: typ ? `"${typ}"` : "absent",
    spec: "RFC 8225 §4",
  });

  const ppt = str(h.ppt);
  checks.push({
    id: "ppt",
    label: "ppt",
    severity: ppt === "shaken" ? "pass" : "fail",
    detail:
      ppt === "shaken"
        ? '"shaken" — the SHAKEN extension applies'
        : ppt
          ? `"${ppt}" — not a SHAKEN PASSporT`
          : "absent, so this is a base PASSporT rather than a SHAKEN one",
    spec: "RFC 8588 §4",
  });

  const alg = str(h.alg);
  checks.push({
    id: "alg",
    label: "alg",
    severity: alg === "ES256" ? "pass" : "fail",
    detail:
      alg === "ES256"
        ? '"ES256"'
        : `"${alg ?? "absent"}" — SHAKEN permits only ES256`,
    spec: "ATIS-1000074",
  });

  const x5u = str(h.x5u);
  checks.push({
    id: "x5u",
    label: "x5u",
    severity: x5u?.startsWith("https://") ? "pass" : "fail",
    detail: x5u
      ? x5u.startsWith("https://")
        ? x5u
        : `${x5u} — must be https`
      : "absent; a verifier has no certificate to fetch",
    spec: "RFC 8225 §4.1",
  });

  return checks;
}

function parameterChecks(p: Parsed): Check[] {
  const h = p.header ?? {};
  const x5u = str(h.x5u);
  const alg = str(h.alg);
  const ppt = str(h.ppt);
  const checks: Check[] = [];

  // RFC 8224 requires the header's parameters to mirror the JOSE header, so a
  // proxy can route on them without opening the token.
  checks.push({
    id: "info",
    label: "info matches x5u",
    severity: p.params.info ? (p.params.info === x5u ? "pass" : "fail") : "fail",
    detail: !p.params.info
      ? "info parameter absent"
      : p.params.info === x5u
        ? "identical"
        : `info names ${p.params.info}, x5u names ${x5u ?? "nothing"}`,
    spec: "RFC 8224 §4",
  });

  checks.push({
    id: "alg-param",
    label: "alg parameter mirrors header",
    severity: !p.params.alg ? "warn" : p.params.alg === alg ? "pass" : "fail",
    detail: !p.params.alg
      ? "absent — defaults to ES256, which matches"
      : p.params.alg === alg
        ? p.params.alg
        : `parameter says ${p.params.alg}, header says ${alg ?? "nothing"}`,
    spec: "RFC 8224 §4",
  });

  checks.push({
    id: "ppt-param",
    label: "ppt parameter mirrors header",
    severity: p.params.ppt === ppt ? "pass" : "fail",
    detail:
      p.params.ppt === ppt
        ? (p.params.ppt ?? "both absent")
        : `parameter says ${p.params.ppt ?? "nothing"}, header says ${ppt ?? "nothing"}`,
    spec: "RFC 8224 §4",
  });

  return checks;
}

function claimChecks(p: Parsed): Check[] {
  const c = p.claims ?? {};
  const checks: Check[] = [];

  const attest = str(c.attest);
  checks.push({
    id: "attest",
    label: "attest",
    severity: attest && ATTESTATIONS[attest] ? "pass" : "fail",
    detail: attest
      ? ATTESTATIONS[attest]
        ? `"${attest}" — ${ATTESTATIONS[attest].name.toLowerCase()}`
        : `"${attest}" is not one of A, B or C`
      : "absent",
    spec: "RFC 8588 §4.1",
  });

  const origid = str(c.origid);
  checks.push({
    id: "origid",
    label: "origid",
    severity: origid ? (UUID.test(origid) ? "pass" : "fail") : "fail",
    detail: origid
      ? UUID.test(origid)
        ? "a UUID, as required — this is the handle a traceback request uses"
        : `"${origid}" is not a UUID`
      : "absent",
    spec: "RFC 8588 §4.2",
  });

  const orig = c.orig as { tn?: unknown } | undefined;
  const origTn = str(orig?.tn);
  checks.push({
    id: "orig",
    label: "orig.tn",
    severity: origTn ? "pass" : "fail",
    detail: origTn ?? "absent or not a string",
    spec: "RFC 8225 §5.2.1",
  });

  const dest = c.dest as { tn?: unknown } | undefined;
  const destTn = Array.isArray(dest?.tn) ? dest.tn : undefined;
  checks.push({
    id: "dest",
    label: "dest.tn",
    severity: destTn && destTn.length > 0 ? "pass" : "fail",
    detail: destTn?.length
      ? destTn.join(", ")
      : "absent, or not the array RFC 8225 requires",
    spec: "RFC 8225 §5.2.2",
  });

  return checks;
}

function canonicalChecks(p: Parsed): Check[] {
  const checks: Check[] = [];

  const sorted = [...p.claimOrder].sort();
  const ordered = p.claimOrder.join(",") === sorted.join(",");
  checks.push({
    id: "order",
    label: "Claims in lexicographic order",
    severity: ordered ? "pass" : "fail",
    detail: ordered
      ? p.claimOrder.join(", ")
      : `serialized as ${p.claimOrder.join(", ")}; canonical form is ${sorted.join(", ")}`,
    spec: "RFC 8225 §9",
  });

  // Re-serialize what was parsed and compare against the bytes that were
  // actually signed. JSON.stringify preserves insertion order, so any
  // difference here is formatting — whitespace or redundant encoding — and
  // not key order, which the check above already covers.
  const raw = p.parts.payload ? b64uToText(p.parts.payload) : "";
  let compact = false;
  try {
    compact = raw === JSON.stringify(JSON.parse(raw));
  } catch {
    compact = false;
  }
  checks.push({
    id: "whitespace",
    label: "No insignificant whitespace",
    severity: compact ? "pass" : "fail",
    detail: compact
      ? "claims are serialized compactly"
      : "the claims carry whitespace or non-minimal encoding, which changes the bytes that were signed",
    spec: "RFC 8225 §9",
  });

  const segs = [p.parts.header, p.parts.payload, p.parts.signature];
  const clean = segs.every((s) => B64U.test(s));
  checks.push({
    id: "b64u",
    label: "Segments are unpadded base64url",
    severity: clean ? "pass" : "fail",
    detail: clean
      ? "no padding, no + or / characters"
      : "a segment uses standard base64 or carries padding",
    spec: "RFC 7515 §2",
  });

  return checks;
}

function timeCheck(p: Parsed, now: number): Check {
  const iat = typeof p.claims?.iat === "number" ? (p.claims.iat as number) : undefined;
  if (iat === undefined) {
    return {
      id: "iat",
      label: "iat freshness",
      severity: "fail",
      detail: "absent — without it a captured token can be replayed forever",
      spec: "RFC 8225 §5.1",
    };
  }
  const ageSeconds = Math.round(now / 1000 - iat);
  const fresh = Math.abs(ageSeconds) <= FRESHNESS_SECONDS;
  return {
    id: "iat",
    label: "iat freshness",
    severity: fresh ? "pass" : "warn",
    detail: fresh
      ? `${ageSeconds}s old, inside the ${FRESHNESS_SECONDS}s window`
      : `${formatAge(ageSeconds)} old — a live verifier would reject this as a replay`,
    spec: "ATIS-1000074",
  };
}

export function formatAge(seconds: number): string {
  const s = Math.abs(seconds);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} hours`;
  return `${Math.round(s / 86400)} days`;
}

/** Everything that can be decided without a public key. */
export function analyse(parsed: Parsed, now: number = Date.now()): Section[] {
  if (parsed.error || !parsed.header || !parsed.claims) return [];
  return [
    { title: "JOSE header", checks: headerChecks(parsed) },
    { title: "Identity parameters", checks: parameterChecks(parsed) },
    { title: "SHAKEN claims", checks: claimChecks(parsed) },
    { title: "Canonical form", checks: canonicalChecks(parsed) },
    { title: "Time", checks: [timeCheck(parsed, now)] },
  ];
}

export function tally(sections: Section[]) {
  const all = sections.flatMap((s) => s.checks);
  return {
    total: all.length,
    failed: all.filter((c) => c.severity === "fail").length,
    warned: all.filter((c) => c.severity === "warn").length,
  };
}
