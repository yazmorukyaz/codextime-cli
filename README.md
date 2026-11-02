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
| `codextime preview` | Builds a local usage summary without uploading usage. npm downloads and pricing lookups may use the network. |
| `codextime login` | Prompts for a Codextime upload token and stores it locally. |
| `codextime sync` | Uploads usage metadata with `Authorization: Bearer <token>`. Authentication does not independently verify reported activity. |
| `codextime doctor` | Checks local Codex logs, config, token presence, API reachability, and token validity. |

For automation only:

```bash
CODEXTIME_UPLOAD_TOKEN=ctu_live_xxxxx npx codextime@latest sync
```

Prefer `codextime login` for normal use so tokens are not pasted into shell history.

## Accounting and Coverage

Version 0.4 uses pinned ccusage 20.0.47 and its per-agent model breakdowns. It selects Codex entries locally, retains model names as reported, and preserves per-model estimated prices rather than dividing a daily price by token share. Models without a known price remain explicitly marked as unpriced; a zero placeholder does not mean free usage.

Only completed UTC days are uploaded. Today's usage remains local until the day closes. The first sync and `--force` inspect retained local history, but do not authorize overwriting existing records. Identical retries from the same installation are no-ops; changed counters, unknown-device history, and overlapping sources are rejected for review. A random installation ID and importer version accompany new uploads. Reports use UTC and large histories are sent in bounded batches. Multi-device daily totals are not automatically merged because retained logs can overlap.

The CLI no longer falls back to a separate raw-log accounting engine. If ccusage fails, the command fails without fabricating totals. Manual event-file imports require explicit costs.

These are local-log observations and API-equivalent estimates, not account billing, remaining plan allowance, measured productivity, or complete cloud and multi-device usage. Existing mixed session/daily imports need reconciliation before a forced replay; the CLI cannot safely decide which historical records to delete.

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
