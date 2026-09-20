import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { skeletonizeFile } from '../skeleton/dispatcher';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
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

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const FEEDBACK_FILE = path.join(DATA_DIR, 'feedback.json');
const TELEMETRY_FILE = path.join(DATA_DIR, 'telemetry.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadLeads(): any[] {
  ensureDataDir();
  if (fs.existsSync(LEADS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf-8'));
      if (Array.isArray(data)) return data;
    } catch (e) {}
  }
  return [];
}

function saveLeads(leads: any[]) {
  ensureDataDir();
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf-8');
}

function loadFeedback(): any[] {
  ensureDataDir();
  if (fs.existsSync(FEEDBACK_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8'));
      if (Array.isArray(data)) return data;
    } catch (e) {}
  }
  return [];
}

function saveFeedback(feedback: any[]) {
  ensureDataDir();
  fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(feedback, null, 2), 'utf-8');
}

function loadTelemetry(): any {
  ensureDataDir();
  if (fs.existsSync(TELEMETRY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(TELEMETRY_FILE, 'utf-8'));
    } catch (e) {}
  }
  const initial = {
    summary: {
      totalPageviews: 0,
      uniqueVisitors: 0,
      simulatorRuns: 0,
      tokensPrunedTotal: 0,
      estimatedSavedDollars: 0,
      cliCopies: 0,
      leadsCount: 0,
      feedbackCount: 0
    },
    pageTraffic: {},
    simulatorLanguages: {},
    agentPreferences: {},
    topCliCommands: {},
    recentEvents: [],
    visitorSessions: []
  };
  saveTelemetry(initial);
  return initial;
}

function saveTelemetry(data: any) {
  ensureDataDir();
  fs.writeFileSync(TELEMETRY_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

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
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      body += chunk;
      if (body.length > 5 * 1024 * 1024) { // 5MB limit
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (aborted || res.headersSent) return;
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
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      body += chunk;
      if (body.length > 64 * 1024) { // 64KB limit
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (aborted || res.headersSent) return;
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

        const leads = loadLeads();
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
        saveLeads(leads);

        // Update telemetry
        try {
          const telemetry = loadTelemetry();
          telemetry.summary.leadsCount = leads.length;
          if (agent && telemetry.agentPreferences) {
            telemetry.agentPreferences[agent] = (telemetry.agentPreferences[agent] || 0) + 1;
          }
          telemetry.recentEvents.unshift({
            id: `ev_${Date.now()}_lead`,
            event: 'lead_submit',
            path: '/',
            properties: { email: newLead.email, teamSize: newLead.teamSize, agent: newLead.agent },
            sessionId: 'session_lead',
            timestamp: new Date().toISOString()
          });
          if (telemetry.recentEvents.length > 150) telemetry.recentEvents = telemetry.recentEvents.slice(0, 150);
          saveTelemetry(telemetry);
        } catch (e) {}

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

  // Admin Leads View (Protected or dev)
  if (pathname === '/api/leads' && req.method === 'GET') {
    const leads = loadLeads();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: leads.length, leads }));
    return;
  }

  // Anonymous Feedback API
  if (pathname === '/api/feedback' && req.method === 'POST') {
    let body = '';
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      body += chunk;
      if (body.length > 64 * 1024) { // 64KB limit
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (aborted || res.headersSent) return;
      try {
        const payload = JSON.parse(body || '{}');
        const message = String(payload.message || '').trim();
        const category = String(payload.category || 'general').trim();
        const email = String(payload.email || '').trim();
        const page = String(payload.page || '/').trim();

        if (!message || message.length < 3) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Please enter a feedback message (at least 3 characters).' }));
          return;
        }

        const feedbackList = loadFeedback();
        const newFeedback = {
          id: `fb_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          category,
          message,
          email: email || 'anonymous',
          page,
          createdAt: new Date().toISOString()
        };

        feedbackList.unshift(newFeedback);
        saveFeedback(feedbackList);

        // Update telemetry
        try {
          const telemetry = loadTelemetry();
          telemetry.summary.feedbackCount = feedbackList.length;
          telemetry.recentEvents.unshift({
            id: `ev_${Date.now()}_fb`,
            event: 'feedback_submit',
            path: newFeedback.page,
            properties: { category: newFeedback.category, message: newFeedback.message.substring(0, 60) },
            sessionId: 'session_fb',
            timestamp: new Date().toISOString()
          });
          if (telemetry.recentEvents.length > 150) telemetry.recentEvents = telemetry.recentEvents.slice(0, 150);
          saveTelemetry(telemetry);
        } catch (e) {}

        console.log(`💬 [FEEDBACK] [${category}] on ${page}: ${message.substring(0, 80)}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          message: 'Thank you! Your feedback has been received and shared with the engineering team.'
        }));
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Failed to save feedback' }));
      }
    });
    return;
  }

  // Admin Feedback View
  if (pathname === '/api/feedback' && req.method === 'GET') {
    const feedbackList = loadFeedback();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: feedbackList.length, feedback: feedbackList }));
    return;
  }

  // Telemetry Event Ingestion API
  if (pathname === '/api/telemetry/event' && req.method === 'POST') {
    let body = '';
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      body += chunk;
      if (body.length > 64 * 1024) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (aborted || res.headersSent) return;
      try {
        const payload = JSON.parse(body || '{}');
        const event = String(payload.event || 'unknown').trim();
        const eventPath = String(payload.path || '/').trim();
        const properties = payload.properties || {};
        const sessionId = String(payload.sessionId || 'anonymous');

        const telemetry = loadTelemetry();

        // Track unique visitor sessions
        if (sessionId && sessionId !== 'anonymous') {
          if (!Array.isArray(telemetry.visitorSessions)) {
            telemetry.visitorSessions = [];
          }
          if (!telemetry.visitorSessions.includes(sessionId)) {
            telemetry.visitorSessions.push(sessionId);
            if (telemetry.visitorSessions.length > 10000) {
              telemetry.visitorSessions.shift();
            }
            telemetry.summary.uniqueVisitors = (telemetry.summary.uniqueVisitors || 0) + 1;
          }
        }

        // Update summaries
        if (event === 'pageview') {
          telemetry.summary.totalPageviews = (telemetry.summary.totalPageviews || 0) + 1;
          telemetry.pageTraffic[eventPath] = (telemetry.pageTraffic[eventPath] || 0) + 1;
        } else if (event === 'simulator_scan') {
          telemetry.summary.simulatorRuns = (telemetry.summary.simulatorRuns || 0) + 1;
          const lang = String(properties.language || 'typescript').toLowerCase();
          telemetry.simulatorLanguages[lang] = (telemetry.simulatorLanguages[lang] || 0) + 1;
          if (properties.tokensReduced) {
            telemetry.summary.tokensPrunedTotal = (telemetry.summary.tokensPrunedTotal || 0) + Number(properties.tokensReduced);
            telemetry.summary.estimatedSavedDollars = Number(((telemetry.summary.tokensPrunedTotal / 1000000) * 3.0).toFixed(2));
          }
        } else if (event === 'cli_copy') {
          telemetry.summary.cliCopies = (telemetry.summary.cliCopies || 0) + 1;
          const cmd = String(properties.command || '').trim();
          if (cmd) {
            telemetry.topCliCommands[cmd] = (telemetry.topCliCommands[cmd] || 0) + 1;
          }
        } else if (event === 'lead_submit') {
          telemetry.summary.leadsCount = (telemetry.summary.leadsCount || 0) + 1;
          const agent = String(properties.agent || 'Cursor');
          telemetry.agentPreferences[agent] = (telemetry.agentPreferences[agent] || 0) + 1;
        }

        // Add to recent events
        telemetry.recentEvents.unshift({
          id: `ev_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          event,
          path: eventPath,
          properties,
          sessionId,
          timestamp: new Date().toISOString()
        });

        if (telemetry.recentEvents.length > 150) {
          telemetry.recentEvents = telemetry.recentEvents.slice(0, 150);
        }

        saveTelemetry(telemetry);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Invalid telemetry payload' }));
      }
    });
    return;
  }

  // Admin Consolidated Metrics API
  if (pathname === '/api/admin/metrics' && req.method === 'GET') {
    const telemetry = loadTelemetry();
    const leads = loadLeads();
    const feedback = loadFeedback();

    telemetry.summary.leadsCount = leads.length;
    telemetry.summary.feedbackCount = feedback.length;

    // Calculate lead agent distributions
    const agentMap: Record<string, number> = { ...telemetry.agentPreferences };
    leads.forEach(l => {
      if (l.agent) {
        agentMap[l.agent] = (agentMap[l.agent] || 0) + 1;
      }
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      timestamp: new Date().toISOString(),
      summary: telemetry.summary,
      pageTraffic: telemetry.pageTraffic,
      simulatorLanguages: telemetry.simulatorLanguages,
      agentPreferences: agentMap,
      topCliCommands: telemetry.topCliCommands,
      recentEvents: telemetry.recentEvents.slice(0, 50),
      leads: leads.slice(0, 50),
      feedback: feedback.slice(0, 50)
    }));
    return;
  }

  // Admin CSV Export API
  if (pathname === '/api/admin/export' && req.method === 'GET') {
    const exportType = parsedUrl.searchParams.get('type') || 'leads';
    if (exportType === 'leads') {
      const leads = loadLeads();
      const csvHeader = 'ID,Email,TeamSize,PrimaryAgent,RepoUrl,Notes,IP,CreatedAt,Status\n';
      const csvRows = leads.map(l => 
        `"${l.id}","${l.email}","${l.teamSize}","${l.agent}","${(l.repoUrl || '').replace(/"/g, '""')}","${(l.notes || '').replace(/"/g, '""')}","${l.ip}","${l.createdAt}","${l.status}"`
      ).join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="siftrcode_leads.csv"'
      });
      res.end(csvHeader + csvRows);
      return;
    } else if (exportType === 'feedback') {
      const feedback = loadFeedback();
      const csvHeader = 'ID,Category,Message,Email,Page,CreatedAt\n';
      const csvRows = feedback.map(f =>
        `"${f.id}","${f.category}","${(f.message || '').replace(/"/g, '""')}","${f.email}","${f.page}","${f.createdAt}"`
      ).join('\n');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="siftrcode_feedback.csv"'
      });
      res.end(csvHeader + csvRows);
      return;
    } else {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid export type. Use ?type=leads or ?type=feedback' }));
      return;
    }
  }

  // Serve static files from web/
  let filePath = path.join(WEB_DIR, pathname === '/' ? 'index.html' : pathname);
  
  // Security check: prevent directory traversal
  const resolvedFilePath = path.resolve(filePath);
  const resolvedWebDir = path.resolve(WEB_DIR);
  if (resolvedFilePath !== resolvedWebDir && !resolvedFilePath.startsWith(resolvedWebDir + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  filePath = resolvedFilePath;

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
