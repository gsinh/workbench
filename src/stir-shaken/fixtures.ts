/**
 * Worked examples, signed for real.
 *
 * These are not hand-written strings that merely look like PASSporTs. A P-256
 * key and a self-signed certificate carrying the SHAKEN TNAuthList extension
 * OID (1.3.6.1.5.5.7.1.26) were generated, and each token below was signed
 * with it using ES256. So the signature check in this demo is doing real
 * ECDSA work against a real certificate, and the tampered sample genuinely
 * fails it rather than being flagged by a hard-coded answer.
 *
 * The certificate is a self-signed throwaway with no private key published
 * and no trust path to any STI-PA. It exists so the signature check has a
 * public key to work with, nothing more.
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

export const SAMPLES: Sample[] = [
  {
    id: "valid",
    label: "Full attestation (A)",
    note:
      "Everything as the specifications require: canonical claim order, parameters mirroring the header, and a signature that verifies.",
    identity:
      "eyJhbGciOiJFUzI1NiIsInBwdCI6InNoYWtlbiIsInR5cCI6InBhc3Nwb3J0IiwieDV1IjoiaHR0cHM6Ly9jZXJ0cy5leGFtcGxlLXRlbGVjb20ubmV0L3NoYWtlbi8xMjM0LmNydCJ9.eyJhdHRlc3QiOiJBIiwiZGVzdCI6eyJ0biI6WyIrMTIxMjU1NTEyMzQiXX0sImlhdCI6MTc5MDA1MzIwMCwib3JpZyI6eyJ0biI6IisxMjE1NTU1MTIxMiJ9LCJvcmlnaWQiOiIxZmZjYTA3Ny0yZDU2LTRmOTMtODc1OS1mYTg1Njc0MGFiM2QifQ.tZPHlhzV8GPwZaSIrG1yTNry6SKr13SEgnbICCfUruR08unv6eR_9FXud-Lw-SUL0CXeAMxKIsiUIc-Kfl4E7Q;info=<https://certs.example-telecom.net/shaken/1234.crt>;alg=ES256;ppt=shaken",
  },
  {
    id: "gateway",
    label: "Gateway attestation (C)",
    note:
      "Signed correctly, but the lowest attestation level — the carrier is passing on a call it cannot vouch for.",
    identity:
      "eyJhbGciOiJFUzI1NiIsInBwdCI6InNoYWtlbiIsInR5cCI6InBhc3Nwb3J0IiwieDV1IjoiaHR0cHM6Ly9jZXJ0cy5leGFtcGxlLXRlbGVjb20ubmV0L3NoYWtlbi8xMjM0LmNydCJ9.eyJhdHRlc3QiOiJDIiwiZGVzdCI6eyJ0biI6WyIrMTIxMjU1NTEyMzQiXX0sImlhdCI6MTc5MDA1MzIwMCwib3JpZyI6eyJ0biI6IisxMjE1NTU1MTIxMiJ9LCJvcmlnaWQiOiI2MDQzMTAyYi0zNDZlLTQyYjEtODFiMC1mMjlhZDQ4M2M5NjAifQ.eirNY6kb299NJVzy4P0i-oaSnIlJWQXhoAtUgkp_6zFpoDcP54nLwlIqIlachjOpMP9cirn6Mk3-3AcdhLeMQQ;info=<https://certs.example-telecom.net/shaken/1234.crt>;alg=ES256;ppt=shaken",
  },
  {
    id: "unordered",
    label: "Claims out of order",
    note:
      "The signature is valid over these exact bytes, yet the claims are not in the lexicographic order RFC 8225 mandates.",
    identity:
      "eyJhbGciOiJFUzI1NiIsInBwdCI6InNoYWtlbiIsInR5cCI6InBhc3Nwb3J0IiwieDV1IjoiaHR0cHM6Ly9jZXJ0cy5leGFtcGxlLXRlbGVjb20ubmV0L3NoYWtlbi8xMjM0LmNydCJ9.eyJvcmlnIjp7InRuIjoiKzEyMTU1NTUxMjEyIn0sImRlc3QiOnsidG4iOlsiKzEyMTI1NTUxMjM0Il19LCJpYXQiOjE3OTAwNTMyMDAsImF0dGVzdCI6IkEiLCJvcmlnaWQiOiIxMDFkNGRlOS1iMzNhLTQ4MzYtOTc5NC0zMWU2NzkyMTdiNDQifQ.TguEl_nNiSUsPs8HKRlucqpD6hMz55lebbpQ86XI-VnDzM9AqJBuJftseFfcJOwHDDeNiVl9mad0LqXXc_YFWg;info=<https://certs.example-telecom.net/shaken/1234.crt>;alg=ES256;ppt=shaken",
  },
  {
    id: "mismatch",
    label: "info does not match x5u",
    note:
      "The Identity parameter names a different certificate than the token's own header does.",
    identity:
      "eyJhbGciOiJFUzI1NiIsInBwdCI6InNoYWtlbiIsInR5cCI6InBhc3Nwb3J0IiwieDV1IjoiaHR0cHM6Ly9jZXJ0cy5leGFtcGxlLXRlbGVjb20ubmV0L3NoYWtlbi8xMjM0LmNydCJ9.eyJhdHRlc3QiOiJBIiwiZGVzdCI6eyJ0biI6WyIrMTIxMjU1NTEyMzQiXX0sImlhdCI6MTc5MDA1MzIwMCwib3JpZyI6eyJ0biI6IisxMjE1NTU1MTIxMiJ9LCJvcmlnaWQiOiIyOTQ4ZTg2Zi02OTFjLTQxZGItODZhOS0xZGU3ZDY5NTZjZWQifQ.1NykxZHmEV69zrUDqM7SRh2gBCciIYDVLSeF4sQ68gQF12a3dM2OPWGJwtC7o8CixcRvXepdWiVG6mXxKa6oOw;info=<https://certs.other-carrier.example/shaken/9999.crt>;alg=ES256;ppt=shaken",
  },
  {
    id: "tampered",
    label: "Attestation upgraded after signing",
    note:
      "C was rewritten to A after the token was signed. Structurally perfect; cryptographically dead.",
    identity:
      "eyJhbGciOiJFUzI1NiIsInBwdCI6InNoYWtlbiIsInR5cCI6InBhc3Nwb3J0IiwieDV1IjoiaHR0cHM6Ly9jZXJ0cy5leGFtcGxlLXRlbGVjb20ubmV0L3NoYWtlbi8xMjM0LmNydCJ9.eyJhdHRlc3QiOiJBIiwiZGVzdCI6eyJ0biI6WyIrMTIxMjU1NTEyMzQiXX0sImlhdCI6MTc5MDA1MzIwMCwib3JpZyI6eyJ0biI6IisxMjE1NTU1MTIxMiJ9LCJvcmlnaWQiOiIxOTg3OTZkZS1kM2Q3LTQ0YjQtOGM5Ni1mMjNhOGJiNzgxYWQifQ.wPtP35DZFYinr7mG9_0cfZcBv2LDitlpTyfMCFEFm9mo3owxlt5lAKBdSuLd230LR17hx3Frr8oVO8qvTDz-yg;info=<https://certs.example-telecom.net/shaken/1234.crt>;alg=ES256;ppt=shaken",
  },
];
