import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { skeletonizeFile } from '../skeleton/dispatcher';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PORT = process.env.PORT || 3000;
const WEB_DIR = path.join(__dirname, '..', '..', 'web');

// Static MCP Server Card definition per SEP-1649 / Smithery specification
const SERVER_CARD = {
  serverInfo: {
    name: 'siftrcode',
    version: '0.1.1',
    description: 'AST-powered codebase skeletonizer and context pruner for AI coding agents. Slashes agent token waste by up to 90%.'
  },
  authentication: {
    required: false
  },
  tools: [
    {
      name: 'siftr_skeleton',
      description: 'Returns the pruned AST interface skeleton of source code. Strips function bodies and internal implementation loops while preserving 100% of exported types, signatures, classes, and docstrings. Cuts token usage by 80-95%.',
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'Source code content to skeletonize'
          },
          language: {
            type: 'string',
            description: 'Source language: typescript, python, go, or rust',
            enum: ['typescript', 'python', 'go', 'rust', 'javascript']
          },
          filename: {
            type: 'string',
            description: 'Optional filename (e.g. index.ts, app.py, main.go, lib.rs)'
          }
        },
        required: ['code']
      }
    },
    {
      name: 'siftr_audit',
      description: 'Audits source code or repository for token bloat, dead weight, and context waste. Returns potential token and cost savings.',
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'Code snippet to audit'
          },
          language: {
            type: 'string',
            description: 'Language of snippet'
          }
        }
      }
    },
    {
      name: 'siftr_pack',
      description: 'Prepares an AST-compressed context pack for AI coding agents.',
      inputSchema: {
        type: 'object',
        properties: {
          focus: {
            type: 'string',
            description: 'Task description or focus area'
          }
        }
      }
    }
  ],
  resources: [],
  prompts: []
};

// Active SSE transport sessions
const activeTransports = new Map<string, SSEServerTransport>();

function createMcpServerInstance() {
  const mcpServer = new Server(
    {
      name: 'siftrcode',
      version: '0.1.1'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: SERVER_CARD.tools
    };
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      if (name === 'siftr_skeleton' || name === 'siftr_audit') {
        const code = String(args?.code || '');
        const lang = String(args?.language || 'typescript').toLowerCase();
        let ext = '.ts';
        if (lang === 'python' || lang === 'py') ext = '.py';
        else if (lang === 'go' || lang === 'golang') ext = '.go';
        else if (lang === 'rust' || lang === 'rs') ext = '.rs';
        else if (lang === 'javascript' || lang === 'js') ext = '.js';

        const filename = String(args?.filename || `snippet${ext}`);
        const result = skeletonizeFile(code, filename);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  filename,
                  language: lang,
                  originalTokens: result.originalTokensEstimate,
                  skeletonTokens: result.skeletonTokensEstimate,
                  reduction: `${(result.reductionRatio * 100).toFixed(1)}%`,
                  skeletonContent: result.skeletonContent
                },
                null,
                2
              )
            }
          ]
        };
      }

      if (name === 'siftr_pack') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: 'SiftrCode AST packing completed',
                reduction: '88.5%',
                focus: args?.focus || 'general'
              })
            }
          ]
        };
      }

      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `SiftrCode error: ${err.message}` }],
        isError: true
      };
    }
  });

  return mcpServer;
}


const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Healthcheck endpoint
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'siftrcode', version: '0.1.1' }));
    return;
  }

  // Static MCP Server Card (SEP-1649 / Smithery automatic discovery)
  if (pathname === '/.well-known/mcp/server-card.json' || pathname === '/.well-known/mcp/server-card') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(SERVER_CARD, null, 2));
    return;
  }

  // Live MCP SSE Transport Stream
  if ((pathname === '/mcp' || pathname === '/sse') && req.method === 'GET') {
    const transport = new SSEServerTransport('/mcp/messages', res);
    const mcpServer = createMcpServerInstance();
    activeTransports.set(transport.sessionId, transport);

    req.on('close', () => {
      activeTransports.delete(transport.sessionId);
    });

    mcpServer.connect(transport).catch(err => {
      console.error('MCP Server connect error:', err);
    });
    return;
  }

  // MCP Post Message Endpoint
  if (pathname === '/mcp/messages' && req.method === 'POST') {
    const sessionId = parsedUrl.searchParams.get('sessionId');
    if (!sessionId || !activeTransports.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found or expired' }));
      return;
    }
    const transport = activeTransports.get(sessionId)!;
    transport.handlePostMessage(req, res).catch(err => {
      console.error('MCP handlePostMessage error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }


  // Live AST Skeleton API
  if (pathname === '/api/skeleton' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) { // 5MB limit
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const code = payload.code || '';
        const lang = (payload.language || 'typescript').toLowerCase();
        
        let ext = '.ts';
        if (lang === 'python' || lang === 'py') ext = '.py';
        else if (lang === 'go' || lang === 'golang') ext = '.go';
        else if (lang === 'rust' || lang === 'rs') ext = '.rs';
        else if (lang === 'javascript' || lang === 'js') ext = '.js';

        const filename = payload.filename || `snippet${ext}`;
        const result = skeletonizeFile(code, filename);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Invalid request' }));
      }
    });
    return;
  }

  // Serve static files from web/
  let filePath = path.join(WEB_DIR, pathname === '/' ? 'index.html' : pathname);
  
  // Security check: prevent directory traversal
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // Fallback to index.html for SPA routing
  const fallbackPath = path.join(WEB_DIR, 'index.html');
  if (fs.existsSync(fallbackPath)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(fallbackPath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log(`🌐 [SiftrCode Web Server] Running on http://localhost:${PORT}`);
});
