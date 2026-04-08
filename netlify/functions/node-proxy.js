// netlify/functions/node-proxy.js
// Proxies JSON-RPC requests to Monero remote nodes
// Solves CORS and mixed-content issues for browser-based wallets

const NODES = [
  'http://xmr-node.cakewallet.com:18081',
  'http://node.monerodevs.org:18089',
  'http://xmr.triplebit.org:18081',
];

exports.handler = async (event) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let requestBody;
  try {
    requestBody = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Determine the endpoint path
  const path = event.queryStringParameters?.path || '/json_rpc';

  // Whitelist allowed RPC methods to prevent abuse
  const allowedJsonRpcMethods = [
    'get_info', 'get_block_count', 'get_fee_estimate',
    'get_last_block_header', 'get_block_header_by_height',
  ];

  const allowedPaths = ['/json_rpc', '/get_transactions', '/get_outs', '/send_raw_transaction'];

  if (!allowedPaths.includes(path)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Path not allowed' }) };
  }

  if (path === '/json_rpc' && requestBody.method && !allowedJsonRpcMethods.includes(requestBody.method)) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: `Method "${requestBody.method}" not allowed` }) };
  }

  // Try nodes in order
  let lastError = null;
  for (const nodeUrl of NODES) {
    try {
      const response = await fetch(nodeUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (response.ok) {
        const data = await response.json();
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify(data),
        };
      }

      lastError = `Node ${nodeUrl} returned ${response.status}`;
    } catch (e) {
      lastError = `Node ${nodeUrl}: ${e.message}`;
    }
  }

  return {
    statusCode: 502,
    headers,
    body: JSON.stringify({ error: 'All nodes unreachable', details: lastError }),
  };
};
