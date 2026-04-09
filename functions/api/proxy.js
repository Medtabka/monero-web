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

const NODES = [
  'http://xmr-node.cakewallet.com:18081',
  'http://node.monerodevs.org:18089',
  'http://xmr.triplebit.org:18081',
];

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

  for (const node of NODES) {
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
