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

### Automatic projects and cross-device tracking (0.5)

Run on each computer using the same Codextime account:

```bash
npx codextime@latest login
npx codextime@latest preview --automatic
npx codextime@latest watch
```

`watch` explicitly enrolls the account and syncs every five minutes while running. Stop with Ctrl+C. No background service is installed. Use `sync --automatic` for one run, `--device-name "Work Mac"` for a label, or `--interval 120` for a different interval (60-3600 seconds).

Enrollment selects a clean UTC start day after existing imported history. If today already has imported usage, tracking starts tomorrow. Existing rows are never overwritten, relabeled, or replayed. Legacy uploads are frozen after enrollment: upgrade every installation to 0.5 or newer. New tracking appears separately from imported history and does not repair missing old logs.

The same session/model observed on multiple computers is counted once. Advancing snapshots add only component deltas; conflicts are held, not summed. Git remote identities are normalized and hashed locally to match projects across computers. Raw remote addresses and paths are not uploaded. Local-only folders receive separate persistent identities; sessions spanning multiple repositories remain unassigned.

Only accessible local logs are covered. Cloud tasks and other computers are not discovered remotely. Ambiguous session identities are skipped. Compressed logs require Node.js 22.15 or newer. Automatic tracking does not calculate costs, approve leaderboard rankings, or publish journal entries.

### Legacy Daily Imports

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
