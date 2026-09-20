/**
 * SiftrCode V2 - AgentAdapter & Observability Tests (Phase 9)
 */

import { strict as assert } from 'assert';
import {
  ClaudeCodeAdapter,
  CursorAdapter,
  GenericMcpAdapter,
  ContextUnitResolved,
  ToolCallRecord,
} from '../agents/agent_adapter';
import { ContextResolution } from '../context/context_resolution';
import {
  createSessionHandle,
  serializeSessionHandle,
  deserializeSessionHandle,
} from '../agents/session_handle';
import { ObservabilityTracer } from '../agents/observability_tracer';

console.log('🧪 Testing AgentAdapter & Observability (Phase 9)...\n');

// Sample resolved units
const testUnits: ContextUnitResolved[] = [
  {
    unitId: 'unit_webhook_01',
    title: 'WebhookHandler.process',
    filePath: 'src/webhook.ts',
    resolution: ContextResolution.BODY,
    content: 'async function process(event) { await dedupe(event); }',
  },
  {
    unitId: 'unit_redis_02',
    title: 'RedisLock',
    filePath: 'src/lock.ts',
    resolution: ContextResolution.SKELETON,
    content: 'export class RedisLock { acquire(): Promise<boolean>; }',
  },
  {
    unitId: 'unit_schema_03',
    title: 'schema.prisma',
    filePath: 'prisma/schema.prisma',
    resolution: ContextResolution.NAME,
  },
  {
    unitId: 'unit_omitted_04',
    title: 'deprecated.ts',
    filePath: 'src/deprecated.ts',
    resolution: ContextResolution.OMIT,
  },
];

// --- 1. ClaudeCodeAdapter Formatting & Parsing ---
console.log('--- 1. ClaudeCodeAdapter Formatting & Parsing ---');
const claudeAdapter = new ClaudeCodeAdapter();
assert.equal(claudeAdapter.id, 'claude-code');
assert.equal(claudeAdapter.capabilities.supportsFileTree, true);
assert.equal(claudeAdapter.capabilities.supportsTerminal, true);

const claudeFormatted = claudeAdapter.formatContext(testUnits, {
  includeInstructions: true,
  instructionPrefix: 'Fix race condition in webhooks.',
});

assert.ok(claudeFormatted.promptText.includes('Fix race condition in webhooks.'));
assert.ok(claudeFormatted.promptText.includes('<context_unit id="unit_webhook_01"'));
assert.ok(claudeFormatted.promptText.includes('[SKELETON] RedisLock'));
// Omitted unit should not be present in sections
assert.equal(claudeFormatted.sections.length, 3);
assert.ok(!claudeFormatted.promptText.includes('deprecated.ts'));
console.log('  ✔ ClaudeCode context formatting includes valid xml tags and filters omitted units');

const sampleRawCalls = [
  {
    tool: 'View',
    input: { path: 'src/webhook.ts' },
    result: 'file contents',
  },
  {
    tool: 'Bash',
    input: { command: 'npm test' },
    error: 'Test failed: Race condition detected',
    durationMs: 450,
  },
];

const parsedClaudeCalls = claudeAdapter.parseToolCalls(sampleRawCalls);
assert.equal(parsedClaudeCalls.length, 2);
assert.equal(parsedClaudeCalls[0].toolName, 'View');
assert.equal(parsedClaudeCalls[0].arguments.path, 'src/webhook.ts');
assert.equal(parsedClaudeCalls[1].toolName, 'Bash');
assert.equal(parsedClaudeCalls[1].error, 'Test failed: Race condition detected');
console.log('  ✔ ClaudeCode parses raw tool calls accurately');

const claudeObs = claudeAdapter.extractObservations(parsedClaudeCalls);
assert.deepEqual(claudeObs.touchedFiles, ['src/webhook.ts']);
assert.deepEqual(claudeObs.executedCommands, ['npm test']);
assert.equal(claudeObs.encounteredErrors.length, 1);
console.log('  ✔ ClaudeCode extracts file and command observations');

// --- 2. CursorAdapter & GenericMcpAdapter Formatting ---
console.log('\n--- 2. CursorAdapter & GenericMcpAdapter Formatting ---');
const cursorAdapter = new CursorAdapter();
assert.equal(cursorAdapter.id, 'cursor');
const cursorFormatted = cursorAdapter.formatContext(testUnits);
assert.ok(cursorFormatted.promptText.includes('### Relevant Repository Context'));
assert.ok(cursorFormatted.promptText.includes('#### `WebhookHandler.process`'));
console.log('  ✔ CursorAdapter formats context as markdown blocks');

const mcpAdapter = new GenericMcpAdapter();
assert.equal(mcpAdapter.id, 'mcp-generic');
const mcpFormatted = mcpAdapter.formatContext(testUnits);
assert.ok(mcpFormatted.promptText.includes('--- src/webhook.ts [BODY] ---'));
console.log('  ✔ GenericMcpAdapter formats structured resource context');

// --- 3. Stateless Session Handles ---
console.log('\n--- 3. Stateless Session Handles ---');
const originalHandle = createSessionHandle(
  'task_abc123',
  'sess_xyz789',
  'snap_w0_clean',
  { model: 'claude-3-7-sonnet' }
);

const serialized = serializeSessionHandle(originalHandle);
assert.ok(serialized.startsWith('siftr_sess_'));
console.log('  ✔ Serialized session handle with valid prefix');

const deserialized = deserializeSessionHandle(serialized);
assert.equal(deserialized.taskId, 'task_abc123');
assert.equal(deserialized.siftrSessionId, 'sess_xyz789');
assert.equal(deserialized.workspaceSnapshotId, 'snap_w0_clean');
assert.equal(deserialized.metadata?.model, 'claude-3-7-sonnet');
console.log('  ✔ Deserialized session handle retains all properties');

// Tamper resistance test
let tamperedThrew = false;
try {
  // Tamper with base64 payload
  const tampered = serialized.slice(0, 20) + 'X' + serialized.slice(21);
  deserializeSessionHandle(tampered);
} catch (err) {
  tamperedThrew = true;
}
assert.ok(tamperedThrew, 'Tampered token must throw error');
console.log('  ✔ Tampered session handle rejected by signature check');

// --- 4. Observability Tracer & Filtering ---
console.log('\n--- 4. Observability Tracer & Filtering ---');
const fullTracer = new ObservabilityTracer('task_abc123', 'FULL_TOOL_TRACE');
fullTracer.recordToolCall({
  timestamp: Date.now(),
  toolName: 'read_file',
  arguments: { filePath: 'src/index.ts' },
  durationMs: 12,
});
fullTracer.recordToolCall({
  timestamp: Date.now(),
  toolName: 'siftr_rank',
  arguments: { query: 'dedup' },
  durationMs: 35,
});
fullTracer.recordTurn({
  role: 'agent',
  content: 'Examining index file to understand routing.',
});

assert.equal(fullTracer.getToolCalls().length, 2);
assert.equal(fullTracer.getTurns().length, 1);
const fullMetrics = fullTracer.computeMetrics();
assert.equal(fullMetrics.totalToolCalls, 2);
assert.equal(fullMetrics.errorCount, 0);
assert.equal(fullMetrics.totalDurationMs, 47);
console.log('  ✔ FULL_TOOL_TRACE records all calls and turns');

const siftrOnlyTracer = new ObservabilityTracer('task_abc123', 'SIFTR_CALLS_ONLY');
siftrOnlyTracer.recordToolCall({
  timestamp: Date.now(),
  toolName: 'read_file',
  arguments: { filePath: 'src/index.ts' },
});
siftrOnlyTracer.recordToolCall({
  timestamp: Date.now(),
  toolName: 'siftr_pack',
  arguments: { budget: 1000 },
});
assert.equal(siftrOnlyTracer.getToolCalls().length, 1);
assert.equal(siftrOnlyTracer.getToolCalls()[0].toolName, 'siftr_pack');
console.log('  ✔ SIFTR_CALLS_ONLY filters non-siftr tool calls');

console.log('\n🎉 All AgentAdapter & Observability tests passed successfully!');
