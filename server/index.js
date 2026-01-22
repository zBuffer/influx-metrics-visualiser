import http from 'http';
import https from 'https';
import { URL } from 'url';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());

// CORS headers for all responses
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Expose-Headers', '*');
  
  if (req.method === 'OPTIONS') {
    res.header('Access-Control-Max-Age', '86400');
    return res.sendStatus(204);
  }
  next();
});

// Dynamic CORS proxy endpoint - accepts target URL from client
app.all('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url || req.body?.url;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing "url" parameter. Provide target URL as query param or in body.' });
  }

  // Normalize URL
  let normalizedUrl = targetUrl;
  if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
    normalizedUrl = 'http://' + normalizedUrl;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch (err) {
    return res.status(400).json({ error: `Invalid URL: ${normalizedUrl}` });
  }

  const protocol = parsedUrl.protocol === 'https:' ? https : http;

  // Forward headers, excluding host
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  headers.host = parsedUrl.host;

  // Track whether response has been sent to prevent "headers already sent" errors
  let responseSent = false;

  const sendErrorResponse = (statusCode, message) => {
    if (responseSent || res.headersSent) {
      console.error(`Cannot send error response (already sent): ${message}`);
      return;
    }
    responseSent = true;
    res.status(statusCode).json({ error: message });
  };

  const proxyReq = protocol.request(
    parsedUrl,
    {
      method: req.method === 'OPTIONS' ? 'GET' : req.method,
      headers,
    },
    (proxyRes) => {
      if (responseSent || res.headersSent) {
        // Response was already sent (e.g., due to timeout), discard proxy response
        proxyRes.resume(); // Drain the response to free up memory
        return;
      }

      responseSent = true;

      // Forward response headers
      Object.entries(proxyRes.headers).forEach(([key, value]) => {
        if (key.toLowerCase() !== 'transfer-encoding') {
          try {
            res.setHeader(key, value);
          } catch (err) {
            console.error(`Failed to set header ${key}:`, err.message);
          }
        }
      });

      res.status(proxyRes.statusCode);

      proxyRes.on('error', (err) => {
        console.error('Proxy response stream error:', err.message);
        // If headers already sent, we can't send an error response
        // Just end the response if possible
        if (!res.writableEnded) {
          res.end();
        }
      });

      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    console.error('Proxy request error:', err.message);
    sendErrorResponse(502, `Proxy error: ${err.message}`);
  });

  // Set a timeout
  proxyReq.setTimeout(30000, () => {
    proxyReq.destroy();
    sendErrorResponse(504, 'Proxy timeout');
  });

  // Handle client disconnect
  req.on('close', () => {
    if (!responseSent && !proxyReq.destroyed) {
      proxyReq.destroy();
    }
  });

  // Forward body for POST/PUT/PATCH
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.body && Object.keys(req.body).length > 0) {
      // If body was parsed as JSON, stringify it
      const bodyData = typeof req.body === 'object' ? JSON.stringify(req.body) : req.body;
      proxyReq.write(bodyData);
    }
  }

  proxyReq.end();
});

// Global error handler for Express - prevents crashes from unhandled errors in routes
// Note: Express error handlers require 4 parameters even if not all are used
app.use((err, _req, res, next) => {
  console.error('Unhandled Express error:', err);
  if (res.headersSent) {
    // If headers already sent, delegate to default Express error handler
    return next(err);
  }
  res.status(500).json({ error: 'Internal server error' });
});

// In production, serve static files from client build
if (process.env.NODE_ENV === 'production') {
  const clientDistPath = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDistPath));

  // SPA fallback
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });
}

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`CORS proxy available at http://localhost:${PORT}/api/proxy?url=<target>`);
  if (process.env.NODE_ENV === 'production') {
    console.log('Serving static files from client/dist');
  } else {
    console.log('Development mode: Run client with "npm run dev" for live reloading');
  }
});

// Handle server-level errors
server.on('error', (err) => {
  console.error('Server error:', err);
});

// Graceful shutdown handling
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  // Don't exit - keep the server running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
  // Don't exit - keep the server running
});

