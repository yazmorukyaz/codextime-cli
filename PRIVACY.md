# Codextime CLI Privacy

Codextime CLI is designed to collect usage metadata, not your work.

## Uploaded

- token counts
- model names
- timestamps
- session IDs
- optional usage metadata
- estimated API-equivalent cost

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
