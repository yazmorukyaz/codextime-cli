# Security Policy

## Reporting Vulnerabilities

Please report suspected vulnerabilities privately by opening a GitHub security advisory in the public `codextime-cli` repository or by contacting the maintainer listed on npm.

Do not include raw upload tokens, secrets, private prompts, source code, or session contents in public issues.

## Supported Package

The official package is:

```bash
npx codextime@latest
```

The legacy `codextime-tracker` package is a temporary migration bridge and should not be used for new installs.

## Security Model

- The CLI is not a security boundary.
- The Codextime API validates upload tokens and derives the user from the token.
- Legacy user ID uploads are unverified and time-limited.
- Supabase service-role keys must never be shipped in the CLI.
- Upload tokens are sent in the Authorization header, not in query strings.
