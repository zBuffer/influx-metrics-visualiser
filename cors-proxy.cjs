#!/usr/bin/env node

const http = require('http');
const https = require('https');
const { URL } = require('url');

let baseURL = process.argv[2];
const port = process.argv[3] || 3001;

if (!baseURL) {
  console.error('Usage: node cors-proxy.js <baseURL> [port]');
  console.error('Example: node cors-proxy.js https://api.example.com 3001');
  console.error('Example: node cors-proxy.js localhost:52166 3001');
  process.exit(1);
}

// Normalize the URL - add http:// if no protocol specified
if (!baseURL.startsWith('http://') && !baseURL.startsWith('https://')) {
  baseURL = 'http://' + baseURL;
}

// Validate the URL
try {
  new URL(baseURL);
} catch (err) {
  console.error(`Invalid URL: ${baseURL}`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  const targetURL = new URL(req.url, baseURL);
  const protocol = targetURL.protocol === 'https:' ? https : http;

  // Copy headers, excluding host
  const headers = { ...req.headers };
  delete headers.host;
  headers.host = targetURL.host;

  const proxyReq = protocol.request(
    targetURL,
    {
      method: req.method,
      headers,
    },
    (proxyRes) => {
      // Add CORS headers to response
      const responseHeaders = {
        ...proxyRes.headers,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': '*',
      };

      res.writeHead(proxyRes.statusCode, responseHeaders);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    console.error('Proxy error:', err.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Proxy error: ${err.message}`);
  });

  req.pipe(proxyReq);
});

server.listen(port, () => {
  console.log(`CORS proxy running on http://localhost:${port}`);
  console.log(`Forwarding requests to ${baseURL}`);
});

