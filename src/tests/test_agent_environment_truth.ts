import * as assert from 'assert';
import {
  createAgentEnvironment,
  createEnvironmentField,
  AgentEnvironment,
  EnvironmentField,
} from '../agents/agent_environment';
import { ClaudeCodeAdapter } from '../agents/agent_adapter';
import { ObservabilityTracer } from '../agents/observability_tracer';
import { ContextEngine } from '../engine/context_engine';

export async function runAgentEnvironmentTruthTests(): Promise<void> {
  console.log('🧪 Testing Observability and AgentEnvironment Truth (Closure PR 0.3)...');

  // ---------------------------------------------------------------------------
  // 1. Truthful AgentEnvironment Defaults & Provenance
  // ---------------------------------------------------------------------------
  console.log('\n--- 1. AgentEnvironment Unsupplied Defaults & Provenance ---');
  {
    const emptyEnv = createAgentEnvironment();

    assert.strictEqual(emptyEnv.model, 'unknown', 'Unsupplied model must default to "unknown"');
    assert.strictEqual(emptyEnv.agentVersion, 'unknown', 'Unsupplied agentVersion must default to "unknown"');
    assert.strictEqual(emptyEnv.agentProvider, 'unknown', 'Unsupplied agentProvider must default to "unknown"');
    assert.strictEqual(emptyEnv.harnessVersion, 'unknown', 'Unsupplied harnessVersion must default to "unknown"');
    assert.deepStrictEqual(emptyEnv.availableTools, [], 'Unsupplied availableTools must default to empty array');

    assert.ok(emptyEnv.provenance, 'Provenance must be populated');
    assert.strictEqual(emptyEnv.provenance.model?.value, null, 'Unsupplied model provenance value must be null');
    assert.strictEqual(emptyEnv.provenance.model?.source, 'UNKNOWN', 'Unsupplied model provenance source must be UNKNOWN');
    assert.strictEqual(emptyEnv.provenance.agentVersion?.source, 'UNKNOWN', 'Unsupplied agentVersion provenance must be UNKNOWN');
    assert.strictEqual(emptyEnv.provenance.agentProvider?.source, 'UNKNOWN', 'Unsupplied agentProvider provenance must be UNKNOWN');

    console.log('  ✔ AgentEnvironment never manufactures defaults (model="unknown", version="unknown")');
    console.log('  ✔ Provenance sources correctly reflect UNKNOWN for unsupplied fields');
  }

  // ---------------------------------------------------------------------------
  // 2. Explicit & Detected Provenance Tracking
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. Explicit & Detected Provenance Tracking ---');
  {
    // Case A: User supplied values without explicit provenance
    const userEnv = createAgentEnvironment({
      model: 'claude-3-5-sonnet-20241022',
      agentProvider: 'anthropic',
      agentVersion: '2.0.0',
      availableTools: ['read_file', 'edit_file'],
    });

    assert.strictEqual(userEnv.model, 'claude-3-5-sonnet-20241022');
    assert.strictEqual(userEnv.provenance?.model?.value, 'claude-3-5-sonnet-20241022');
    assert.strictEqual(userEnv.provenance?.model?.source, 'USER_SUPPLIED');
    assert.strictEqual(userEnv.provenance?.agentProvider?.source, 'USER_SUPPLIED');
    assert.strictEqual(userEnv.provenance?.availableTools?.source, 'USER_SUPPLIED');

    // Case B: Explicit caller provenance (e.g. DETECTED from IDE process / AGENT_REPORTED)
    const detectedEnv = createAgentEnvironment({
      model: 'cursor-small',
      agentProvider: 'cursor',
      provenance: {
        model: { value: 'cursor-small', source: 'DETECTED' },
        agentProvider: { value: 'cursor', source: 'DETECTED' },
        agentVersion: { value: '0.42.0', source: 'AGENT_REPORTED' },
      },
    });

    assert.strictEqual(detectedEnv.provenance?.model?.source, 'DETECTED');
    assert.strictEqual(detectedEnv.provenance?.agentProvider?.source, 'DETECTED');
    assert.strictEqual(detectedEnv.provenance?.agentVersion?.source, 'AGENT_REPORTED');

    // Helper createEnvironmentField utility
    const field = createEnvironmentField('custom-model', 'USER_SUPPLIED');
    assert.strictEqual(field.value, 'custom-model');
    assert.strictEqual(field.source, 'USER_SUPPLIED');

    const unknownField = createEnvironmentField(undefined);
    assert.strictEqual(unknownField.value, null);
    assert.strictEqual(unknownField.source, 'UNKNOWN');

    console.log('  ✔ User-supplied parameters receive USER_SUPPLIED provenance');
    console.log('  ✔ Custom provenance preserves DETECTED and AGENT_REPORTED sources');
  }

  // ---------------------------------------------------------------------------
  // 3. Claude Code Adapter Conservative Default (SIFTR_CALLS_ONLY)
  // ---------------------------------------------------------------------------
  console.log('\n--- 3. ClaudeCodeAdapter Conservative Defaults ---');
  {
    const defaultClaude = new ClaudeCodeAdapter();
    assert.strictEqual(
      defaultClaude.observabilityLevel,
      'SIFTR_CALLS_ONLY',
      'ClaudeCodeAdapter must default to SIFTR_CALLS_ONLY without verified hooks'
    );
    assert.strictEqual(defaultClaude.observationCoverage.activeCoverage.fileReads, false);
    assert.strictEqual(defaultClaude.observationCoverage.activeCoverage.fileEdits, false);
    assert.strictEqual(defaultClaude.observationCoverage.activeCoverage.mcpCalls, true);

    // Initialized with verified hooks
    const verifiedClaude = new ClaudeCodeAdapter({
      fileReads: true,
      fileEdits: true,
      shellCommands: true,
    });
    assert.strictEqual(
      verifiedClaude.observabilityLevel,
      'FULL_TOOL_TRACE',
      'ClaudeCodeAdapter with verified hooks initializes to FULL_TOOL_TRACE'
    );

    console.log('  ✔ ClaudeCodeAdapter defaults to SIFTR_CALLS_ONLY');
    console.log('  ✔ ClaudeCodeAdapter promotes to FULL_TOOL_TRACE only when verified hooks exist');
  }

  // ---------------------------------------------------------------------------
  // 4. ObservabilityTracer Conservative Default
  // ---------------------------------------------------------------------------
  console.log('\n--- 4. ObservabilityTracer Conservative Default ---');
  {
    const tracer = new ObservabilityTracer('task_pr03_truth');
    assert.strictEqual(
      tracer.getLevel(),
      'SIFTR_CALLS_ONLY',
      'ObservabilityTracer must default to SIFTR_CALLS_ONLY'
    );

    // Filter non-siftr tool calls under default SIFTR_CALLS_ONLY
    tracer.recordToolCall({
      timestamp: Date.now(),
      toolName: 'read_file',
      arguments: { path: 'src/secret.ts' },
    });
    assert.strictEqual(tracer.getToolCalls().length, 0, 'Non-siftr tool calls must be ignored under SIFTR_CALLS_ONLY');

    // Siftr calls must be recorded
    tracer.recordToolCall({
      timestamp: Date.now(),
      toolName: 'siftr_context',
      arguments: { prompt: 'refactor' },
    });
    assert.strictEqual(tracer.getToolCalls().length, 1, 'siftr_ tool calls must be recorded under SIFTR_CALLS_ONLY');

    // Caller explicitly promotes observability level
    tracer.setLevel('FULL_TOOL_TRACE');
    assert.strictEqual(tracer.getLevel(), 'FULL_TOOL_TRACE');

    tracer.recordToolCall({
      timestamp: Date.now(),
      toolName: 'read_file',
      arguments: { path: 'src/secret.ts' },
    });
    assert.strictEqual(tracer.getToolCalls().length, 2, 'All calls recorded after explicit promotion to FULL_TOOL_TRACE');

    console.log('  ✔ ObservabilityTracer defaults to SIFTR_CALLS_ONLY');
    console.log('  ✔ Caller must explicitly promote tracer to FULL_TOOL_TRACE');
  }

  // ---------------------------------------------------------------------------
  // 5. ContextEngine Truthful TaskContext Integration
  // ---------------------------------------------------------------------------
  console.log('\n--- 5. ContextEngine Truthful TaskContext Integration ---');
  {
    // Test optimizeWorkspace without agentModel
    const resultUnspecified = await ContextEngine.optimizeWorkspace({
      workspaceDir: process.cwd(),
      prompt: 'Verify truthful agent environment telemetry',
      tokenBudget: 5000,
    });

    const envUnspecified = resultUnspecified.task.agentEnvironment;
    assert.strictEqual(envUnspecified.model, 'unknown');
    assert.strictEqual(envUnspecified.agentVersion, 'unknown');
    assert.strictEqual(envUnspecified.provenance?.model?.source, 'UNKNOWN');
    assert.strictEqual(envUnspecified.provenance?.agentVersion?.source, 'UNKNOWN');

    // Test optimizeWorkspace with explicit agentModel
    const resultSpecified = await ContextEngine.optimizeWorkspace({
      workspaceDir: process.cwd(),
      prompt: 'Verify truthful agent environment telemetry with specified model',
      agentModel: 'claude-3-5-sonnet-20241022',
      agentKind: 'claude_code',
      tokenBudget: 5000,
    });

    const envSpecified = resultSpecified.task.agentEnvironment;
    assert.strictEqual(envSpecified.model, 'claude-3-5-sonnet-20241022');
    assert.strictEqual(envSpecified.agentProvider, 'claude_code');
    assert.strictEqual(envSpecified.provenance?.model?.source, 'USER_SUPPLIED');
    assert.strictEqual(envSpecified.provenance?.agentProvider?.source, 'USER_SUPPLIED');

    console.log('  ✔ ContextEngine produces truthful AgentEnvironment with UNKNOWN when unspecified');
    console.log('  ✔ ContextEngine records USER_SUPPLIED provenance when model is explicitly provided');
  }

  console.log('\n🎉 All Observability and AgentEnvironment Truth tests passed successfully!');
}

if (require.main === module) {
  runAgentEnvironmentTruthTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}
