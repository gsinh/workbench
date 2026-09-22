/**
 * Certificate parsing and signature verification.
 *
 * The one part of this experiment that needs the browser. Everything here runs
 * locally: the certificate is parsed in JavaScript and the signature is checked
 * by WebCrypto. No key material, no token and no certificate leaves the page.
 *
 * There is deliberately no ASN.1 library. Reaching SubjectPublicKeyInfo inside
 * an X.509 certificate is about forty lines of DER walking, and writing them
 * out makes the structure legible instead of hiding it behind a dependency.
 */

import { b64uToBytes } from "./model";

type TLV = {
  tag: number;
  start: number;
  contentStart: number;
  length: number;
  end: number;
};

/** Read one DER tag-length-value at `offset`. */
function readTLV(bytes: Uint8Array, offset: number): TLV {
  const tag = bytes[offset];
  let i = offset + 1;
  let length = bytes[i];
  i += 1;
  // Long form: the low seven bits say how many bytes carry the real length.
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let k = 0; k < count; k += 1) {
      length = length * 256 + bytes[i];
      i += 1;
    }
  }
  return { tag, start: offset, contentStart: i, length, end: i + length };
}

function children(bytes: Uint8Array, node: TLV): TLV[] {
  const out: TLV[] = [];
  let i = node.contentStart;
  while (i < node.end) {
    const child = readTLV(bytes, i);
    if (child.end <= child.start) break;
    out.push(child);
    i = child.end;
  }
  return out;
}

export function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
}

/**
 * Pull SubjectPublicKeyInfo out of an X.509 certificate.
 *
 *   Certificate  ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
 *   TBSCertificate ::= SEQUENCE {
 *     version [0] EXPLICIT ... OPTIONAL,   <- context tag 0xA0 when present
 *     serialNumber, signature, issuer, validity, subject,
 *     subjectPublicKeyInfo, ... }
 *
 * So SPKI is the seventh field when version is present and the sixth when it
 * is not. WebCrypto imports that sub-structure directly as "spki".
 */
export function spkiFromCertificate(der: Uint8Array): Uint8Array {
  const certificate = readTLV(der, 0);
  const tbs = children(der, certificate)[0];
  if (!tbs) throw new Error("Not a certificate: no tbsCertificate.");
  const fields = children(der, tbs);
  const hasVersion = fields[0]?.tag === 0xa0;
  const spki = fields[hasVersion ? 6 : 5];
  if (!spki) throw new Error("No SubjectPublicKeyInfo found.");
  return der.slice(spki.start, spki.end);
}

/** The SHAKEN certificate extension, by OID 1.3.6.1.5.5.7.1.26. */
const TN_AUTH_LIST = [0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x01, 0x1a];

/**
 * Whether the certificate carries a TNAuthList extension.
 *
 * Matched by scanning for the encoded OID rather than walking to the extension
 * list, which is enough to answer "is this a telephone-number certificate at
 * all" without another hundred lines of parsing.
 */
export function hasTnAuthList(der: Uint8Array): boolean {
  outer: for (let i = 0; i + TN_AUTH_LIST.length <= der.length; i += 1) {
    for (let k = 0; k < TN_AUTH_LIST.length; k += 1) {
      if (der[i + k] !== TN_AUTH_LIST[k]) continue outer;
    }
    return true;
  }
  return false;
}

export type Verification =
  | { state: "valid" }
  | { state: "invalid" }
  | { state: "error"; message: string };

/**
 * Verify the PASSporT signature against a certificate.
 *
 * JOSE carries an ES256 signature as raw R||S, 64 bytes — not the DER-wrapped
 * form OpenSSL emits by default. WebCrypto's ECDSA verify expects exactly the
 * raw form, so nothing needs unwrapping here; it is the mismatch that catches
 * people out when they go the other way.
 */
export async function verifySignature(
  signingInput: string,
  signatureB64u: string,
  certificatePem: string,
): Promise<Verification> {
  try {
    const der = pemToDer(certificatePem.trim());
    const spki = spkiFromCertificate(der);
    const key = await crypto.subtle.importKey(
      "spki",
      spki as BufferSource,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      b64uToBytes(signatureB64u) as BufferSource,
      new TextEncoder().encode(signingInput),
    );
    return { state: ok ? "valid" : "invalid" };
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : "Could not read the certificate.",
    };
  }
}
