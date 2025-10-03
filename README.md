# Gemini CLI Proxy (Logging Proxy)

Minimal Node/Express proxy designed to sit between a CLI/client and an upstream LLM API (e.g., Gemini / OpenAI‑compatible). It logs every request and response to an NDJSON file and offers a simple web UI to browse logs as a collapsible JSON tree. Streaming (SSE) responses are supported and captured for final logging.

## Highlights

- Logs full JSON request bodies to `logs/requests.ndjson` (one JSON object per line).
- Logs responses with status code and parsed content summary.
- Body fields are parsed as JSON when possible; otherwise raw text is preserved.
- Simple dashboard at `/logs` to inspect recent entries as expandable JSON.
- Handles streaming (SSE) by piping to client and collecting for a final log entry.
- Basic CORS support for browser-based clients.

## Requirements

- Node.js 18+ (or Node 16+ with `node-fetch@3` polyfill automatically loaded).

## Quick Start

1) Install dependencies (if any) and start the server:

```bash
node server.js
```

2) Send your client/CLI traffic to the proxy instead of directly to the upstream. The proxy forwards POST requests and logs them.

3) Visit the dashboard:

```
http://localhost:<PORT>/logs
```

4) Tail the raw NDJSON log (optional):

```bash
tail -f logs/requests.ndjson
```

## Configuration

Set environment variables in your shell or a `.env` file in the project root.

- `PORT` (number): HTTP port (default `5000`).
- `AUTO_PORT` (bool): Auto-pick a free port if `PORT` is busy (default `true`).
- `API_BASE` (string): Upstream base URL (default `https://generativelanguage.googleapis.com`). Trailing slashes are trimmed.
- `ROUTE_PREFIX` (string): Proxy path prefix (e.g., `v1`, `v1beta`). Set to empty to serve at root.

Note: This proxy logs requests/responses. Do not use it in production with sensitive data unless you’ve reviewed, sanitized, or disabled the relevant logging.

## How It Works

- All POST requests matching the proxy prefix are forwarded to `API_BASE` + original path.
- Request JSON bodies are logged directly as objects.
- Response bodies are captured. If the body is valid JSON, it is stored as an object/array under `body`; otherwise the raw text is stored. A best‑effort `content` string is extracted for quick scanning.
- SSE responses are streamed to the client. Collected chunks are concatenated and logged after the stream ends.

## Endpoints

- `GET /health` → `{ ok: true, apiBase: <API_BASE>, namespace: <API_NAMESPACE> }`
- `GET /logs` → Static dashboard UI for browsing recent entries.
- `GET /logs/data?limit=200` → Returns `{ entries: [...] }` with the most recent NDJSON entries.
- `POST <any proxied route>` → Forwards to `API_BASE` + route; logs request/response.

## Log Format (NDJSON)

One JSON object per line in `logs/requests.ndjson`.

Request entry example (Gemini):

```json
{
  "ts": "2025-09-16T12:34:56.789Z",
  "id": "<uuid>",
  "type": "request",
  "route": "/v1beta/models/gemini-2.5-pro:generateContent",
  "target": "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
  "body": {
    "contents": [
      {
        "role": "user",
        "parts": [ { "text": "Hello" } ]
      }
    ]
  }
}
```

Response entry example (Gemini):

```json
{
  "ts": "2025-09-16T12:34:57.123Z",
  "id": "<uuid>",
  "type": "response",
  "route": "/v1beta/models/gemini-2.5-pro:generateContent",
  "status": 200,
  "body": {
    "candidates": [
      {
        "content": {
          "role": "model",
          "parts": [ { "text": "Hello! How can I help you today?" } ]
        },
        "finishReason": "STOP",
        "index": 0
      }
    ],
    "usageMetadata": {
      "promptTokenCount": 10,
      "candidatesTokenCount": 10,
      "totalTokenCount": 20
    },
    "modelVersion": "gemini-2.5-pro"
  },
  "content": "Hello! How can I help you today?"
}
```

Notes:
- `body` is parsed JSON when possible; otherwise a string containing the raw body text.
- `content` is a convenience string extracted from common response shapes and SSE chunks.
- For streaming (`:streamGenerateContent`), the UI merges SSE events into a single object for readability.

## Dashboard UI

Visit `http://localhost:<PORT>/logs` to explore the latest entries with:

- Adjustable `limit` (up to 1000) and manual refresh.
- Expandable JSON tree for each entry (request/response grouped by `id` ordering).
- Request/response bodies visible and parsed as JSON when possible.

## Example: cURL (Gemini)

```bash
curl -sS \
  -H "Content-Type: application/json" \
  -X POST \
  --data '{
    "contents": [
      {"role": "user", "parts": [{"text": "Hello"}]}
    ]
  }' \
  "http://localhost:5000/v1beta/models/gemini-2.5-pro:generateContent?key=$API_KEY"
```

Check the server logs and `logs/requests.ndjson`, then open `/logs` to view structured entries.

## Troubleshooting

- Port in use → change `PORT` or keep `AUTO_PORT=true` to auto‑increment.
- Empty logs → ensure you’re sending POST requests to the proxy URL and that `logs/` is writable.
- 401/403 → supply an upstream key via client header or `UPSTREAM_API_KEY`.
- Streaming looks odd → SSE is piped raw to the client but fully collected for the final log entry.

## Security

This is a debugging tool. It logs request/response data, which may include sensitive inputs, prompts, and outputs. Use only in controlled environments and scrub logs if necessary.

---

Happy debugging and prompt‑tracing!
