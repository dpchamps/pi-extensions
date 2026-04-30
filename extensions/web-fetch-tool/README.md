# web-fetch-tool

Adds a `web_fetch` tool that retrieves URL content and returns either structured JSON or extracted markdown/text.

## Behavior

- Uses domain-specific processors when a matching handler is configured in `domains/*.json`
- Falls back to generic HTML extraction via Readability + Turndown
- Returns plain text for non-HTML responses

## Current domain handlers

- Reddit listings and comment threads
- Imgur albums and images
- arXiv abstract and PDF URLs

## Output

- Supported domains typically return JSON
- Generic webpages return markdown
- Non-HTML responses return text

## Files

- `index.ts` — tool registration and fetch pipeline
- `domains/*.json` — URL matching and fetch/processor config
- `processors/*.ts` — per-domain shaping logic
