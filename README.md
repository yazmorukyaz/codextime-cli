# Codextime CLI

Open-source CLI for syncing local Codex usage metadata to Codextime.

## Install

```bash
npx codextime@latest preview
npx codextime@latest login
npx codextime@latest sync
```

## Commands

| Command | Purpose |
| --- | --- |
| `codextime preview` | Builds a local summary of what would be uploaded. It does not write to the network. |
| `codextime login` | Prompts for a Codextime upload token and stores it locally. |
| `codextime sync` | Uploads verified usage metadata with `Authorization: Bearer <token>`. |
| `codextime doctor` | Checks local Codex logs, config, token presence, API reachability, and token validity. |

For automation only:

```bash
CODEXTIME_UPLOAD_TOKEN=ctu_live_xxxxx npx codextime@latest sync
```

Prefer `codextime login` for normal use so tokens are not pasted into shell history.

## What It Uploads

- token counts
- model names
- timestamps
- session IDs
- optional usage metadata
- estimated API-equivalent cost

## What It Does Not Upload

- prompts
- responses
- source code
- file contents
- secrets
- environment variables

## Legacy Migration

`codextime-tracker` is the old package name. It is kept as a temporary migration bridge only. Legacy user ID sync is unverified and stops working after June 17, 2026.

## Development

```bash
npm install
npm run build
npm test
npm pack --dry-run --json
```

The npm package should contain only `dist`, examples, package metadata, and public docs.
