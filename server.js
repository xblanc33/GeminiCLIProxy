/**
 * Node/Express minimal proxy to log Gemini-CLI
 *
 * Features
 * - Logs full JSON request bodies (messages, params) to console and a file (logs/requests.ndjson)
 * - Supports streaming (SSE) by piping the upstream response
 * - Config via .env file
 *
 */

const fs = require('fs');
const { promises: fsp } = fs;
const path = require('path');
const express = require('express');
const { Readable } = require('stream');
const crypto = require('crypto');
require('dotenv').config(); // charge .env

const app = express();
app.use(express.json({ limit: '5mb' }));
// Basic CORS support for browser-based clients
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, OpenAI-Organization, OpenAI-Project, OpenAI-Beta');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, res, next) => {
  // Log incoming requests
  console.log(`[incoming] ${req.method} ${req.originalUrl} from ${req.ip}`);
  next();
});

// Ensure fetch exists (support Node <18 via node-fetch@3)
if (typeof globalThis.fetch !== 'function') {
  try {
    // Verify node-fetch is installed
    require.resolve('node-fetch');
    // Lazy polyfill: dynamic import keeps CJS compatibility
    globalThis.fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    console.log('[startup] Using node-fetch polyfill for global fetch');
  } catch (e) {
    console.error('[startup] Global fetch not found and node-fetch is not installed. Install with: npm i node-fetch@3');
    process.exit(1);
  }
}

// Diagnostics: capture unexpected exits/signals/errors
process.on('exit', (code) => {
  console.log(`[process] exit with code ${code}`);
});
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
  process.on(sig, () => {
    console.log(`[process] received ${sig}, shutting down`);
    process.exit(0);
  });
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason);
});

const PORT = Number(process.env.PORT || 5000);
const API_BASE = (() => {
  const fallbackBase = 'https://generativelanguage.googleapis.com';
  const envBase = typeof process.env.API_BASE === 'string' ? process.env.API_BASE.trim() : '';
  let base = envBase || fallbackBase;
  base = base.replace(/\/+$/, '');
  return base;
})();
const ROUTE_PREFIX = process.env.ROUTE_PREFIX || '';
const AUTO_PORT = String(process.env.AUTO_PORT || 'true').toLowerCase() === 'true';
const LOG_RAW_BODY = String(process.env.LOG_RAW_BODY || 'true').toLowerCase() === 'true';



// Ensure log directory exists
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'requests.ndjson');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 1000;

function logRequest(id, route, body, upstreamUrl) {
  const entry = {
    ts: new Date().toISOString(),
    id,
    type: 'request',
    route,
    ...(upstreamUrl ? { target: upstreamUrl } : {}),
    body,
  };
  const line = JSON.stringify(entry) + '\n';
  fs.appendFile(LOG_FILE, line, (err) => {
    if (err) console.error('Failed to write log:', err);
  });
  console.log(`\n=== ${route} @ ${entry.ts} ===`);
  if (upstreamUrl) {
    console.log(`[target] ${upstreamUrl}`);
  }
  console.log(JSON.stringify(body, null, 2));
}

async function loadRecentLogs(limit = DEFAULT_LOG_LIMIT) {
  const effectiveLimit = Math.min(Math.max(1, Number(limit) || DEFAULT_LOG_LIMIT), MAX_LOG_LIMIT);
  try {
    const data = await fsp.readFile(LOG_FILE, 'utf8');
    const lines = data.split(/\r?\n/).filter(Boolean);
    const recent = lines.slice(-effectiveLimit);
    return recent.map((line) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        return { ts: new Date().toISOString(), type: 'parse_error', raw: line, error: err.message };
      }
    });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function logResponseFull(id, route, status, headers, bodyText, summaryText) {
  // Extract tool calls for better human readability in logs
  const toolCalls = extractToolCalls(bodyText, headers);
  // Try to parse body as JSON for structured logging
  let parsedBody = null;
  if (LOG_RAW_BODY) {
    try {
      parsedBody = JSON.parse(bodyText);
    } catch (_) {
      // keep as text if not JSON
    }
  }
  const entry = {
    ts: new Date().toISOString(),
    id,
    type: 'response',
    route,
    status,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(LOG_RAW_BODY ? { body: parsedBody ?? bodyText } : {}),
    content: summaryText,
  };
  fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', (err) => {
    if (err) console.error('Failed to write response log:', err);
  });
}

function extractContentFromJson(json) {
  try {
    if (!json || typeof json !== 'object') return '';
    // chat/completions (non-stream)
    if (Array.isArray(json.choices) && json.choices.length) {
      const parts = [];
      for (const c of json.choices) {
        if (c && c.message && typeof c.message.content === 'string') parts.push(c.message.content);
        else if (typeof c.text === 'string') parts.push(c.text);
      }
      if (parts.length) return parts.join('');
    }
    // responses API convenience
    if (Array.isArray(json.output_text) && json.output_text.length) {
      return json.output_text.join('');
    }
    if (typeof json.output_text === 'string') return json.output_text;
    // Some responses use top-level "content" as string
    if (typeof json.content === 'string') return json.content;
    // responses API output items
    if (Array.isArray(json.output)) {
      const texts = [];
      for (const item of json.output) {
        if (item && (item.type === 'output_text' || item.type === 'message') && typeof item.text === 'string') texts.push(item.text);
        else if (item && item.content && Array.isArray(item.content)) {
          for (const p of item.content) {
            if (p && typeof p.text === 'string') texts.push(p.text);
          }
        }
      }
      if (texts.length) return texts.join('');
    }
  } catch (_) {}
  return '';
}

function extractContentFromSSE(bodyText) {
  const lines = bodyText.split(/\r?\n/);
  const acc = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const evt = JSON.parse(payload);
      // chat/completions streaming
      if (evt && Array.isArray(evt.choices)) {
        for (const c of evt.choices) {
          if (c && c.delta && typeof c.delta.content === 'string') acc.push(c.delta.content);
          else if (typeof c.text === 'string') acc.push(c.text);
        }
        continue;
      }
      // responses API streaming
      if (evt && typeof evt === 'object') {
        // convenience: many events include { type, delta: { type: 'output_text.delta', text } }
        if (evt.delta && typeof evt.delta.text === 'string') {
          acc.push(evt.delta.text);
          continue;
        }
        // Fallback: walk object to collect all string values named 'text' under 'delta'
        const stack = [];
        if (evt.delta && typeof evt.delta === 'object') stack.push(evt.delta);
        while (stack.length) {
          const cur = stack.pop();
          for (const k of Object.keys(cur)) {
            const v = cur[k];
            if (typeof v === 'string' && (k === 'text' || k === 'content')) acc.push(v);
            else if (v && typeof v === 'object') stack.push(v);
          }
        }
      }
    } catch (_) {
      // ignore malformed SSE chunk
    }
  }
  return acc.join('');
}

function extractContent(bodyText, headers) {
  try {
    const ct = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
    if (ct.includes('text/event-stream') || /^data:/m.test(bodyText)) {
      return extractContentFromSSE(bodyText);
    }
    // Try JSON parsing
    try {
      const json = JSON.parse(bodyText);
      const c = extractContentFromJson(json);
      if (c) return c;
    } catch (_) {}
  } catch (_) {}
  return '';
}

// Extract tool calls from final JSON objects
function extractToolCallsFromJson(json) {
  try {
    const calls = [];
    // chat/completions final message.tool_calls
    if (Array.isArray(json.choices)) {
      for (const c of json.choices) {
        const msg = c && c.message;
        const tcs = msg && Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        for (const tc of tcs) {
          const fn = tc.function || tc;
          const name = fn && typeof fn.name === 'string' ? fn.name : undefined;
          const args = fn && typeof fn.arguments === 'string' ? fn.arguments : undefined;
          if (name || args) calls.push({ name, arguments: args });
        }
      }
    }
    // responses API: attempt best-effort extraction if present under top-level "tool_calls"
    if (Array.isArray(json.tool_calls)) {
      for (const tc of json.tool_calls) {
        const fn = tc.function || tc;
        const name = fn && typeof fn.name === 'string' ? fn.name : undefined;
        const args = fn && typeof fn.arguments === 'string' ? fn.arguments : undefined;
        if (name || args) calls.push({ name, arguments: args });
      }
    }
    return calls;
  } catch (_) { return []; }
}

// Extract tool calls from an SSE stream by accumulating delta.tool_calls fragments
function extractToolCallsFromSSE(bodyText) {
  const lines = bodyText.split(/\r?\n/);
  const accByIndex = new Map(); // index -> { name, arguments }
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let evt; try { evt = JSON.parse(payload); } catch { continue; }
    const choices = evt && Array.isArray(evt.choices) ? evt.choices : [];
    for (const ch of choices) {
      const delta = ch && ch.delta;
      if (!delta || !Array.isArray(delta.tool_calls)) continue;
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        const entry = accByIndex.get(idx) || { name: '', arguments: '' };
        const fn = tc.function || {};
        if (typeof fn.name === 'string' && !entry.name) entry.name = fn.name;
        if (typeof fn.arguments === 'string' && fn.arguments) entry.arguments += fn.arguments;
        accByIndex.set(idx, entry);
      }
    }
  }
  return Array.from(accByIndex.values()).filter(e => e.name || e.arguments);
}

function extractToolCalls(bodyText, headers) {
  try {
    const ct = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
    if (ct.includes('text/event-stream') || /^data:/m.test(bodyText)) {
      return extractToolCallsFromSSE(bodyText);
    }
    try {
      const json = JSON.parse(bodyText);
      return extractToolCallsFromJson(json);
    } catch (_) { /* not JSON */ }
  } catch (_) {}
  return [];
}

//streamGenerateContent

async function sendRequestToUpstream(req) {
  const body = req.body || {};

  let upstreamUrl = API_BASE + req.url;
  
  const headers = {};
  // Copy headers from req, but strip hop-by-hop and problematic ones
  Object.keys(req.headers).forEach((key) => {
    const lk = key.toLowerCase();
    if (['content-length', 'host', 'connection', 'transfer-encoding', 'accept-encoding', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade'].includes(lk)) {
      return;
    }
    headers[key] = req.headers[key];
  });

  // check if there is a content-type header, if not, set it to application/json
  if (!headers['content-type'] && !headers['Content-Type']) {
    console.log('[proxy] No Content-Type header found, setting to application/json');
    headers['Content-Type'] = 'application/json';
  }

  const reqId = (crypto.randomUUID && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  logRequest(reqId, req.url, body, upstreamUrl);

  console.log(`[proxy] ${req.method} ${upstreamUrl}`);
  console.log(`body : ${JSON.stringify(body).slice(0, 1000)}${JSON.stringify(body).length > 1000 ? '...' : ''}`);
  console.log(`headers: ${JSON.stringify(headers).slice(0, 1000)}${JSON.stringify(headers).length > 1000 ? '...' : ''}`);

  
  const upstreamResp = await fetch(upstreamUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return { upstreamResp, reqId, route : req.url, upstreamUrl };
}

async function sendUpstreamResponseToClient(upstreamResp, res, ctx) {
  const { reqId, route } = ctx || {};
  res.status(upstreamResp.status);

  // Prepare plain headers map for logging and sanitize before forwarding
  const plainHeaders = {};
  upstreamResp.headers.forEach((value, key) => { plainHeaders[key] = value; });

  // Remove or override hop-by-hop and encoding/length headers that can be invalid after decoding/streaming
  // Always treat keys in a case-insensitive way (fetch returns lowercase keys, but be safe)
  const removeHeader = (obj, name) => {
    const lc = name.toLowerCase();
    Object.keys(obj).forEach((k) => {
      if (k.toLowerCase() === lc) delete obj[k];
    });
  };


  // print headers
  console.log(`[proxy] Upstream response headers: ${JSON.stringify(plainHeaders).slice(0, 1000)}${JSON.stringify(plainHeaders).length > 1000 ? '...' : ''}`);
  
  const ct = String(plainHeaders['content-type'] || plainHeaders['Content-Type'] || '').toLowerCase();
  const routeStr = typeof route === 'string' ? route : '';
  const shouldStream = routeStr.toLowerCase().includes('streamgeneratecontent') || ct.includes('text/event-stream');

  if (shouldStream) {
    console.log('[proxy] Streaming response detected, piping to client');
    // Forward upstream content-type (or default to JSON streaming)
    const origCT = plainHeaders['content-type'] || plainHeaders['Content-Type'];
    res.setHeader('Content-Type', origCT || 'application/json; charset=utf-8');
    // Do not set Content-Length for streaming
    if (typeof res.flushHeaders === 'function') {
      try { res.flushHeaders(); } catch (_) {}
    }

    const body = upstreamResp.body;
    if (!body) { res.end(); return; }

    try {
      const nodeStream = Readable.fromWeb(body);
      const collected = [];
      nodeStream.on('error', (err) => {
        console.error('Upstream stream error:', err);
        if (!res.headersSent) res.status(502);
        res.end();
      });
      nodeStream.on('data', (chunk) => {
        console.log(`[proxy] Streaming chunk: ${chunk.length} bytes`);
        try { collected.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); } catch (_) {}
      });
      nodeStream.on('end', () => {
        console.log('[proxy] Upstream stream ended');
        try {
          const text = Buffer.concat(collected).toString('utf8');
          // Pretty-print JSON in console when possible
          try {
            const parsed = JSON.parse(text);
            console.log(JSON.stringify(parsed, null, 2));
          } catch (_) {
            console.log(text);
          }
          const content = extractContent(text, plainHeaders);
          if (reqId && route) logResponseFull(reqId, route, upstreamResp.status, plainHeaders, text, content);
        } catch (_) {}
      });
      nodeStream.pipe(res);
    } catch (err) {
      console.error('[proxy] Failed to stream upstream body:', err);
      if (!res.headersSent) res.status(502).end(); else res.end();
    }
    return;
  } else {
    console.log('[proxy] Non-streaming response, buffering entire body before forwarding');
    try {
      // Forward safe headers (without length/encoding); set Content-Length after buffering
      removeHeader(plainHeaders, 'content-length');
      removeHeader(plainHeaders, 'content-length');
      removeHeader(plainHeaders, 'content-encoding');
      removeHeader(plainHeaders, 'transfer-encoding');
      removeHeader(plainHeaders, 'connection');
      removeHeader(plainHeaders, 'keep-alive');


      Object.keys(plainHeaders).forEach((key) => {
        res.setHeader(key, plainHeaders[key]);
      });
      const ab = await upstreamResp.arrayBuffer();
      const buf = Buffer.from(ab);
      const textPreview = (() => {
        try { return buf.toString('utf8'); } catch { return ''; }
      })();
      // Pretty-print JSON in console when possible
      try {
        const parsed = JSON.parse(textPreview);
        console.log(JSON.stringify(parsed, null, 2));
      } catch (_) {
        console.log(textPreview);
      }
      // Set correct Content-Length and forward safe headers
      res.setHeader('content-length', String(buf.length));
      // If upstream didn't send content-type, default to application/json
      if (!plainHeaders['content-type'] && !plainHeaders['Content-Type']) {
        res.setHeader('Content-Type', 'application/json');
      }

      // Log aggregated response for debugging
      try {
        const content = extractContent(textPreview, plainHeaders);
        if (reqId && route) logResponseFull(reqId, route, upstreamResp.status, plainHeaders, textPreview, content);
      } catch (_) {}

      res.status(upstreamResp.status);
      res.write(buf);
      res.send();
      console.log('[proxy] Response fully sent to client');
    } catch (err) {
      console.error('[proxy] Error reading upstream response body:', err);
      if (!res.headersSent) res.status(502).end();
      else res.end();
    }
  }
}

async function proxyPost(req, res) {

  console.log(`\n\n\n\n[proxy] Proxying POST to upstream path segment: ${req.url}\n\n`);

  try {
    const { upstreamResp, reqId, route } = await sendRequestToUpstream(req);
    console.log(`[proxy] Upstream response: ${upstreamResp.status} ${upstreamResp.statusText}`);
    await sendUpstreamResponseToClient(upstreamResp, res, { reqId, route });
  }
  catch (err) {
    console.error('[proxy] Error during proxying:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Proxy error', detail: err.message });
    else res.end();
  }
    
}

app.get('/health', (_req, res) => res.json({ ok: true, apiBase: API_BASE, namespace: API_NAMESPACE }));

app.get('/logs/data', async (req, res) => {
  try {
    const { limit } = req.query;
    const entries = await loadRecentLogs(limit);
    res.json({ entries });
  } catch (err) {
    console.error('[logs] Failed to read log file:', err);
    res.status(500).json({ error: 'Failed to read logs', detail: err.message });
  }
});

app.delete('/logs/data', async (_req, res) => {
  try {
    await fsp.writeFile(LOG_FILE, '');
    res.json({ ok: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // Nothing to clear
      return res.json({ ok: true });
    }
    console.error('[logs] Failed to clear log file:', err);
    res.status(500).json({ error: 'Failed to clear logs', detail: err.message });
  }
});

app.get('/logs', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'logs.html'));
});

const PROXY_PREFIX = ROUTE_PREFIX || '';

const prefixRegex = new RegExp(`^${PROXY_PREFIX}(.*)`);
app.post(prefixRegex, (req, res) => proxyPost(req, res));

function startListening(port, triesLeft = 10) {
  const server = app.listen(port, () => {
    console.log(`LLM logging proxy listening on http://localhost:${port}`);
    if (port !== PORT) {
      console.log(`[port] ${PORT} was busy, auto-switched to ${port}`);
    }
    console.log(`Upstream base: ${API_BASE}`);
    console.log(`Logging to: ${LOG_FILE}`);
  });
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && AUTO_PORT && triesLeft > 0) {
      const nextPort = port + 1;
      console.warn(`[server] Port ${port} in use. Retrying on ${nextPort}...`);
      setTimeout(() => startListening(nextPort, triesLeft - 1), 150);
      return;
    }
    console.error('[server] error:', err);
    process.exit(1);
  });
}

startListening(PORT);
