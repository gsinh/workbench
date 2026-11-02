/**
 * TEST FIXTURES — NOT CREDENTIALS.
 *
 * Secret scanners may flag the samples below as JSON Web Tokens. They are
 * STIR/SHAKEN PASSporTs (RFC 8225/8588), which are JWTs by design, kept as
 * worked examples for the inspector. They grant access to nothing:
 *
 *   - the telephone numbers are fictional 555 numbers;
 *   - the certificate URLs are on example domains (example-telecom.net,
 *     other-carrier.example) and resolve nowhere;
 *   - they were signed once with a throwaway P-256 key whose private half has
 *     never been committed to this repository (checked across its full
 *     history);
 *   - the certificate below is that key's public half, self-signed, with no
 *     trust path to any STI-PA.
 *
 * Worked examples, signed for real.
 *
 * These are not hand-written strings that merely look like PASSporTs. A P-256
 * key and a self-signed certificate carrying the SHAKEN TNAuthList extension
 * OID (1.3.6.1.5.5.7.1.26) were generated, and each token below was signed
 * with it using ES256. So the signature check in this demo is doing real
 * ECDSA work against a real certificate, and the tampered sample genuinely
 * fails it rather than being flagged by a hard-coded answer.
 */

export type Sample = {
  id: string;
  label: string;
  note: string;
  identity: string;
};

export const SAMPLE_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIICAjCCAaegAwIBAgIUU8x/jIsLcyFxPo8GEA//1iv+m0MwCgYIKoZIzj0EAwIw
VDELMAkGA1UEBhMCVVMxGDAWBgNVBAoMD0V4YW1wbGUgVGVsZWNvbTErMCkGA1UE
AwwiU0hBS0VOIEV4YW1wbGUgU2lnbmluZyBDZXJ0aWZpY2F0ZTAeFw0yNjA5MjIw
NTA5MDRaFw0zNjA5MTkwNTA5MDRaMFQxCzAJBgNVBAYTAlVTMRgwFgYDVQQKDA9F
eGFtcGxlIFRlbGVjb20xKzApBgNVBAMMIlNIQUtFTiBFeGFtcGxlIFNpZ25pbmcg
Q2VydGlmaWNhdGUwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARtAswKxsOVXpSt
5RoM1X9Dznjn3goH9lkQ04dJi/Ih4t+IUXBnU7P+Xa9DyFA/yxpv6BF81DxiKxUt
fpPCyamko1cwVTAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDAWBggrBgEF
BQcBGgQKMAigBhYEMTIzNDAdBgNVHQ4EFgQU6cd7qcwU32dyEeTK9XUejGufvdgw
CgYIKoZIzj0EAwIDSQAwRgIhAOJVKKL/zhFn/ZgLM+6zdubEkeMunCCTXXGftgMz
uxJ1AiEA7Tjt4oM8/rbrqI6aChxjRnSM906GkxRVifxxYod/XGo=
-----END CERTIFICATE-----`;

/**
 * The PASSporT header every sample shares, as the exact JSON text that was
 * signed. Kept as readable JSON rather than a pre-encoded token: these are
 * test fixtures, and anyone reviewing them should see the fictional claims
 * at a glance rather than an opaque string.
 */
const HEADER = "{\"alg\":\"ES256\",\"ppt\":\"shaken\",\"typ\":\"passport\",\"x5u\":\"https://certs.example-telecom.net/shaken/1234.crt\"}";

/** UTF-8 text to base64url without padding, as JWS compact form uses. */
function b64u(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A SIP Identity header value: the compact PASSporT (header, payload and
 * signature, base64url-joined) and its parameters. The payload is passed as
 * the exact JSON text that was signed, so the bytes, and therefore the
 * signature check, are unchanged.
 */
function passport(payload: string, signature: string, info: string): string {
  return `${b64u(HEADER)}.${b64u(payload)}.${signature};info=<${info}>;alg=ES256;ppt=shaken`;
}

export const SAMPLES: Sample[] = [
  {
    id: "valid",
    label: "Full attestation (A)",
    note:
      "Everything as the specifications require: canonical claim order, parameters mirroring the header, and a signature that verifies.",
    identity: passport(
      "{\"attest\":\"A\",\"dest\":{\"tn\":[\"+12125551234\"]},\"iat\":1790053200,\"orig\":{\"tn\":\"+12155551212\"},\"origid\":\"1ffca077-2d56-4f93-8759-fa856740ab3d\"}",
      "tZPHlhzV8GPwZaSIrG1yTNry6SKr13SEgnbICCfUruR08unv6eR_9FXud-Lw-SUL0CXeAMxKIsiUIc-Kfl4E7Q",
      "https://certs.example-telecom.net/shaken/1234.crt",
    ),
  },
  {
    id: "gateway",
    label: "Gateway attestation (C)",
    note:
      "Signed correctly, but the lowest attestation level — the carrier is passing on a call it cannot vouch for.",
    identity: passport(
      "{\"attest\":\"C\",\"dest\":{\"tn\":[\"+12125551234\"]},\"iat\":1790053200,\"orig\":{\"tn\":\"+12155551212\"},\"origid\":\"6043102b-346e-42b1-81b0-f29ad483c960\"}",
      "eirNY6kb299NJVzy4P0i-oaSnIlJWQXhoAtUgkp_6zFpoDcP54nLwlIqIlachjOpMP9cirn6Mk3-3AcdhLeMQQ",
      "https://certs.example-telecom.net/shaken/1234.crt",
    ),
  },
  {
    id: "unordered",
    label: "Claims out of order",
    note:
      "The signature is valid over these exact bytes, yet the claims are not in the lexicographic order RFC 8225 mandates.",
    identity: passport(
      "{\"orig\":{\"tn\":\"+12155551212\"},\"dest\":{\"tn\":[\"+12125551234\"]},\"iat\":1790053200,\"attest\":\"A\",\"origid\":\"101d4de9-b33a-4836-9794-31e679217b44\"}",
      "TguEl_nNiSUsPs8HKRlucqpD6hMz55lebbpQ86XI-VnDzM9AqJBuJftseFfcJOwHDDeNiVl9mad0LqXXc_YFWg",
      "https://certs.example-telecom.net/shaken/1234.crt",
    ),
  },
  {
    id: "mismatch",
    label: "info does not match x5u",
    note:
      "The Identity parameter names a different certificate than the token's own header does.",
    identity: passport(
      "{\"attest\":\"A\",\"dest\":{\"tn\":[\"+12125551234\"]},\"iat\":1790053200,\"orig\":{\"tn\":\"+12155551212\"},\"origid\":\"2948e86f-691c-41db-86a9-1de7d6956ced\"}",
      "1NykxZHmEV69zrUDqM7SRh2gBCciIYDVLSeF4sQ68gQF12a3dM2OPWGJwtC7o8CixcRvXepdWiVG6mXxKa6oOw",
      "https://certs.other-carrier.example/shaken/9999.crt",
    ),
  },
  {
    id: "tampered",
    label: "Attestation upgraded after signing",
    note:
      "C was rewritten to A after the token was signed. Structurally perfect; cryptographically dead.",
    identity: passport(
      "{\"attest\":\"A\",\"dest\":{\"tn\":[\"+12125551234\"]},\"iat\":1790053200,\"orig\":{\"tn\":\"+12155551212\"},\"origid\":\"198796de-d3d7-44b4-8c96-f23a8bb781ad\"}",
      "wPtP35DZFYinr7mG9_0cfZcBv2LDitlpTyfMCFEFm9mo3owxlt5lAKBdSuLd230LR17hx3Frr8oVO8qvTDz-yg",
      "https://certs.example-telecom.net/shaken/1234.crt",
    ),
  },
];
