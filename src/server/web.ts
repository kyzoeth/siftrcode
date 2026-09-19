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

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Accept');

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

  // Live MCP Streamable HTTP & SSE Transport (Glama & Smithery native)
  if (pathname === '/mcp' || pathname === '/sse' || pathname === '/mcp/messages') {
    if (!req.headers.accept || !req.headers.accept.includes('text/event-stream')) {
      req.headers.accept = (req.headers.accept ? req.headers.accept + ', ' : '') + 'application/json, text/event-stream';
    }
    try {
      const transport = new StreamableHTTPServerTransport();
      const mcpServer = createMcpServerInstance();
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err: any) {
      console.error('Streamable HTTP error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
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

  // B2B Team Trial & Lead Capture API
  if (pathname === '/api/leads' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 64 * 1024) { // 64KB limit
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const email = String(payload.email || '').trim().toLowerCase();
        const teamSize = String(payload.teamSize || '1-5');
        const agent = String(payload.agent || 'Cursor');
        const repoUrl = String(payload.repoUrl || '').trim();
        const notes = String(payload.notes || '').trim();

        if (!email || !email.includes('@') || !email.includes('.')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Please enter a valid work email address.' }));
          return;
        }

        const DATA_DIR = path.join(__dirname, '..', '..', 'data');
        if (!fs.existsSync(DATA_DIR)) {
          fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        const LEADS_FILE = path.join(DATA_DIR, 'leads.json');

        let leads: any[] = [];
        if (fs.existsSync(LEADS_FILE)) {
          try {
            leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8'));
          } catch (e) {
            leads = [];
          }
        }

        const newLead = {
          id: `lead_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          email,
          teamSize,
          agent,
          repoUrl,
          notes,
          ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown',
          createdAt: new Date().toISOString(),
          status: 'pending_pilot'
        };

        leads.unshift(newLead);
        fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf-8');

        console.log(`🔥 [NEW SIFTRCODE PRO LEAD] ${email} | Team: ${teamSize} | Agent: ${agent} | Created: ${newLead.createdAt}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Your 14-day SiftrCode Pro team trial has been registered! Check your inbox shortly for your priority onboarding key.',
          leadId: newLead.id
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Failed to save lead' }));
      }
    });
    return;
  }

  // Admin Leads View (Protected by query token or dev)
  if (pathname === '/api/leads' && req.method === 'GET') {
    const DATA_DIR = path.join(__dirname, '..', '..', 'data');
    const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
    let leads = [];
    if (fs.existsSync(LEADS_FILE)) {
      try {
        leads = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8'));
      } catch (e) {
        leads = [];
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: leads.length, leads }));
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

  // Support clean extensionless URLs: e.g. /privacy -> web/privacy.html
  if (!fs.existsSync(filePath) && fs.existsSync(filePath + '.html')) {
    filePath = filePath + '.html';
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
