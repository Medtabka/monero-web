// SPDX-License-Identifier: MIT
// functions/api/proxy.js — Cloudflare Pages Function
//
// Drop-in replacement for netlify/functions/node-proxy.js. Cloudflare Pages
// auto-routes any file under functions/ to its matching URL path, so this
// file is reachable at  https://<site>/api/proxy
//
// The contract is identical to the Netlify version: it accepts a POST whose
// body is the original JSON-RPC request, with a ?path= query string telling
// the proxy which endpoint on the upstream node to forward to.
//
// js/monero-rpc.js calls this with `?path=/json_rpc` for normal calls and
// `?path=/get_outs`, `/get_transactions`, `/send_raw_transaction` for the
// non-JSON-RPC paths.

// Our own monero node, served by Cloudflare in front of nginx in front of
// monerod on a Hetzner CAX21. We prefer this over the public fallbacks
// whenever it's actually synced — see ourNodeIsSynced() below.
const OWN_NODE = 'https://node.monero-web.com';

// Public fallback nodes. Used while OWN_NODE is still syncing or offline.
const PUBLIC_NODES = [
  'http://xmr-node.cakewallet.com:18081',
  'http://node.monerodevs.org:18089',
  'http://xmr.triplebit.org:18081',
];

// Per-isolate cache of OWN_NODE's sync status. Cloudflare Pages Functions
// reuse module-level state across invocations within a single isolate, so
// this caches the answer for ~60s and avoids hammering OWN_NODE on every
// request. When the isolate is recycled the cache resets — that's fine.
let syncCheck = { ts: 0, ok: false };
const SYNC_TTL_MS = 60_000;

async function ourNodeIsSynced () {
  const now = Date.now();
  if (now - syncCheck.ts < SYNC_TTL_MS) return syncCheck.ok;
  syncCheck.ts = now;
  syncCheck.ok = false;
  try {
    const r = await fetch(OWN_NODE + '/json_rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' }),
      signal: AbortSignal.timeout(3000),
    });
    if (r.ok) {
      const d = await r.json();
      // Treat the node as ready iff it explicitly reports synchronized=true.
      // While monerod is still catching up this is false, and we keep
      // serving from the public fallbacks.
      syncCheck.ok = d && d.result && d.result.synchronized === true;
    }
  } catch (e) { /* swallow — falls back to public nodes */ }
  return syncCheck.ok;
}

async function chooseNodes () {
  return (await ourNodeIsSynced())
    ? [OWN_NODE, ...PUBLIC_NODES]
    : [...PUBLIC_NODES];
}

const ALLOWED_JSON_RPC_METHODS = new Set([
  'get_info',
  'get_block_count',
  'get_fee_estimate',
  'get_last_block_header',
  'get_block_header_by_height',
]);

const ALLOWED_PATHS = new Set([
  '/json_rpc',
  '/get_transactions',
  '/get_outs',
  '/send_raw_transaction',
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type':                 'application/json',
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.searchParams.get('path') || '/json_rpc';

  if (!ALLOWED_PATHS.has(path)) {
    return json(403, { error: 'Path not allowed' });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(400, { error: 'Invalid JSON' });
  }

  if (path === '/json_rpc' && body.method && !ALLOWED_JSON_RPC_METHODS.has(body.method)) {
    return json(403, { error: `Method "${body.method}" not allowed` });
  }

  const serialized = JSON.stringify(body);
  let lastError = null;

  const nodes = await chooseNodes();
  for (const node of nodes) {
    try {
      const upstream = await fetch(node + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: serialized,
      });
      if (upstream.ok) {
        // Re-emit with our CORS headers (we can't pipe upstream headers verbatim)
        const data = await upstream.text();
        return new Response(data, { status: 200, headers: CORS_HEADERS });
      }
      lastError = `${node} → HTTP ${upstream.status}`;
    } catch (e) {
      lastError = `${node} → ${e.message}`;
    }
  }

  return json(502, { error: 'All upstream nodes unreachable', details: lastError });
}

// Reject anything that isn't POST or OPTIONS
export async function onRequest(context) {
  const m = context.request.method;
  if (m === 'POST')    return onRequestPost(context);
  if (m === 'OPTIONS') return onRequestOptions();
  return json(405, { error: 'Method not allowed' });
}
