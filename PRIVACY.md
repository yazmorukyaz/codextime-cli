# Codextime CLI Privacy

Codextime CLI is designed to collect usage metadata, not your work.

Automatic imports use ccusage's unified per-agent report, which may inspect metadata from other coding agents on your machine. Codextime selects only Codex entries before building an upload. Other-agent entries, raw local paths, prompts, responses, and source files are not included in automatic imports.

`preview` does not upload usage. Installing the pinned engine and fetching public pricing data can make network requests. Manual input files may contain optional metadata supplied by you; do not put secrets in those files.

## Uploaded

Automatic session tracking additionally sends project display names, hashed normalized Git identities (or random local-folder identities), the fixed tracking start day, component counters, and an optional installation label. Git hashes are stable identifiers, not anonymization of public repository names. Raw Git addresses, credentials, and working directories remain local. Local project identities are stored under `~/.codextime/project-identities`.

Enrollment freezes legacy imports and starts a separate tracking window without modifying existing usage. `watch` runs only while its foreground process is running; no system service is installed.

- token counts
- model names
- timestamps
- session IDs
- optional usage metadata
- estimated API-equivalent cost
- random installation ID, importer version, and source coverage labels

The installation ID is created at first sync in `~/.codextime/installation-id`. It is not a hardware identifier. Copying this file to another computer also copies its identity; separate installations should not share it. Historical records are not retroactively assigned a device.

## Not Uploaded

- prompts
- responses
- source code
- file contents
- secrets
- environment variables
- API keys

## Token Handling

`codextime login` prompts for a dashboard-issued upload token and stores it in `~/.codextime/config.json` with restricted file permissions where supported.

The CLI masks tokens in normal output, doctor output, and error paths. Do not paste long-lived upload tokens into screenshots, public logs, shell startup files, or shared command snippets.

For automation, prefer short-lived scoped environments and pass the token with `CODEXTIME_UPLOAD_TOKEN`.
