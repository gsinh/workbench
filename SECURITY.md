# Security

## Test fixtures that look like tokens

`src/stir-shaken/fixtures.ts` contains five STIR/SHAKEN PASSporTs used as
worked examples by the STIR/SHAKEN inspector. A PASSporT is a JSON Web Token
by design, so secret scanners may report them. They are not credentials:

- the telephone numbers are fictional 555 numbers;
- the certificate URLs are on example domains and resolve nowhere;
- they were signed once with a throwaway P-256 key whose private half has never
  been committed to this repository (checked across its full history);
- the certificate in the same file is that key's public half, self-signed, with
  no trust path to any STI-PA.

They grant access to nothing. The file is excluded from secret scanning by
`.gitleaks.toml` and `.github/secret_scanning.yml`, and from nothing else.
Every push and pull request is scanned for secrets by the `secrets` workflow.

## Reporting a vulnerability

Please report security issues privately to the maintainer, through the
contact details on their GitHub profile, rather than in a public issue.
