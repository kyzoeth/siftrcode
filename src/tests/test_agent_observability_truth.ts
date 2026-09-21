/**
 * SiftrCode V2 - Agent Observability Truth Tests
 * Verifies Remediation PR 8:
 * 1. Do not overclaim observability (Section 28)
 * 2. Separate capability from active coverage (Section 29)
 * 3. Dynamic computeObservabilityLevel based on verified hooks (Section 29, 31)
 * 4. Conservative Generic MCP defaults to SIFTR_CALLS_ONLY (Section 30)
 * 5. Full tool trace assigned only when interactions are actually captured (Section 31)
 * 6. Dynamic verification via verifyActiveCoverage
 * 7. Downstream outcome-evidence linkage with truth in telemetry
 */

import * as assert from 'assert';
import {
  ClaudeCodeAdapter,
  CursorAdapter,
  GenericMcpAdapter,
  computeObservabilityLevel,
  ActiveObservationCoverage,
} from '../agents/agent_adapter';
import {
  createExposureDecisionV2,
} from '../telemetry/exposure_decision';
import {
  computeLabelEvidence,
} from '../telemetry/candidate_observation';
import { ContextResolution } from '../context/context_resolution';

export async function runAgentObservabilityTruthTests(): Promise<void> {
  console.log('\n=== Running V2 Agent Observability Truth Tests (Remediation PR 8) ===');

  // ---------------------------------------------------------------------------
  // 1. Dynamic ObservabilityLevel Computation from Active Coverage (Section 29)
  // ---------------------------------------------------------------------------
  console.log('\n--- 1. Dynamic ObservabilityLevel Computation ---');
  {
    // Full tool coverage: fileReads + fileEdits + shellCommands
    const fullActive: ActiveObservationCoverage = {
      fileReads: true,
      fileEdits: true,
      shellCommands: true,
      tests: true,
      nativeSearch: true,
      mcpCalls: true,
    };
    assert.strictEqual(
      computeObservabilityLevel(fullActive),
      'FULL_TOOL_TRACE',
      'All primary tool hooks active must yield FULL_TOOL_TRACE'
    );

    // Partial coverage: fileEdits only (e.g. IDE edit tracking without read hook)
    const partialEditsOnly: ActiveObservationCoverage = {
      fileReads: false,
      fileEdits: true,
      shellCommands: false,
      tests: false,
      nativeSearch: false,
      mcpCalls: true,
    };
    assert.strictEqual(
      computeObservabilityLevel(partialEditsOnly),
      'PARTIAL_AGENT_TRACE',
      'Edits-only coverage must yield PARTIAL_AGENT_TRACE'
    );

    // Minimal coverage: MCP tool calls only
    const mcpOnly: ActiveObservationCoverage = {
      fileReads: false,
      fileEdits: false,
      shellCommands: false,
      tests: false,
      nativeSearch: false,
      mcpCalls: true,
    };
    assert.strictEqual(
      computeObservabilityLevel(mcpOnly),
      'SIFTR_CALLS_ONLY',
      'MCP tool calls only must yield SIFTR_CALLS_ONLY'
    );

    // Empty coverage
    const noCoverage: ActiveObservationCoverage = {
      fileReads: false,
      fileEdits: false,
      shellCommands: false,
      tests: false,
      nativeSearch: false,
      mcpCalls: false,
    };
    assert.strictEqual(
      computeObservabilityLevel(noCoverage),
      'SIFTR_CALLS_ONLY',
      'Zero coverage must default to SIFTR_CALLS_ONLY'
    );

    console.log('  ✔ ObservabilityLevel strictly computed from active verified hooks, not theoretical capability');
  }

  // ---------------------------------------------------------------------------
  // 2. Conservative Generic MCP Defaults (Section 30)
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. Conservative Generic MCP Defaults ---');
  {
    const mcpAdapter = new GenericMcpAdapter();

    assert.strictEqual(
      mcpAdapter.observabilityLevel,
      'SIFTR_CALLS_ONLY',
      'Generic MCP must default conservatively to SIFTR_CALLS_ONLY'
    );
    assert.strictEqual(mcpAdapter.observationCoverage.activeCoverage.fileReads, false);
    assert.strictEqual(mcpAdapter.observationCoverage.activeCoverage.fileEdits, false);
    assert.strictEqual(mcpAdapter.observationCoverage.activeCoverage.mcpCalls, true);

    // Upgrading via verified hook installation
    mcpAdapter.verifyActiveCoverage({ fileEdits: true, fileReads: true, shellCommands: true });
    assert.strictEqual(
      mcpAdapter.observabilityLevel,
      'FULL_TOOL_TRACE',
      'Generic MCP upgrades to FULL_TOOL_TRACE only with verified active hooks'
    );

    console.log('  ✔ Generic MCP strictly defaults to SIFTR_CALLS_ONLY and prevents unwarranted claims');
  }

  // ---------------------------------------------------------------------------
  // 3. Claude Code Adapter Truthful Coverage & Dynamic Degradation
  // ---------------------------------------------------------------------------
  console.log('\n--- 3. Claude Code Adapter Truthful Coverage ---');
  {
    // Closure PR 0.3: Claude defaults conservatively to SIFTR_CALLS_ONLY unless verified hooks exist
    const claude = new ClaudeCodeAdapter();
    assert.strictEqual(
      claude.observabilityLevel,
      'SIFTR_CALLS_ONLY',
      'Claude adapter must default conservatively to SIFTR_CALLS_ONLY'
    );
    assert.strictEqual(claude.observationCoverage.activeCoverage.fileReads, false);
    assert.strictEqual(claude.observationCoverage.activeCoverage.fileEdits, false);

    // Active verification of fileReads + fileEdits + shellCommands promotes to FULL_TOOL_TRACE:
    claude.verifyActiveCoverage({ fileReads: true, fileEdits: true, shellCommands: true });
    assert.strictEqual(
      claude.observabilityLevel,
      'FULL_TOOL_TRACE',
      'Actively verified tool hooks promote Claude adapter to FULL_TOOL_TRACE'
    );

    // If file-reading telemetry hook is disabled by environment policy:
    claude.verifyActiveCoverage({ fileReads: false });
    assert.strictEqual(
      claude.observabilityLevel,
      'PARTIAL_AGENT_TRACE',
      'Disabling file read hook truthfully demotes adapter to PARTIAL_AGENT_TRACE'
    );

    // If command hooks are also disabled:
    claude.verifyActiveCoverage({ shellCommands: false, fileEdits: false, tests: false });
    assert.strictEqual(
      claude.observabilityLevel,
      'SIFTR_CALLS_ONLY',
      'Disabling all hooks demotes adapter to SIFTR_CALLS_ONLY'
    );

    console.log('  ✔ ClaudeCodeAdapter dynamically reflects active runtime instrumentation');
  }

  // ---------------------------------------------------------------------------
  // 4. Cursor Adapter Truthful Coverage (Section 28)
  // ---------------------------------------------------------------------------
  console.log('\n--- 4. Cursor Adapter Truthful Coverage ---');
  {
    const cursor = new CursorAdapter();

    // Section 21 & 43 Invariant: Cursor without handshake defaults to SIFTR_CALLS_ONLY
    assert.strictEqual(
      cursor.observationCoverage.activeCoverage.fileReads,
      false,
      'Cursor fileReads hook must be unverified/false by default'
    );
    assert.strictEqual(
      cursor.observabilityLevel,
      'SIFTR_CALLS_ONLY',
      'Cursor must default to SIFTR_CALLS_ONLY without active verified handshake'
    );

    // When file edits hook is actively installed and verified (or via handshake):
    cursor.verifyActiveCoverage({ fileEdits: true });
    assert.strictEqual(
      cursor.observabilityLevel,
      'PARTIAL_AGENT_TRACE',
      'Cursor upgrades to PARTIAL_AGENT_TRACE when file edit hook is verified'
    );

    // When file read hook and commands are actively installed and verified:
    cursor.verifyActiveCoverage({ fileReads: true, shellCommands: true });
    assert.strictEqual(
      cursor.observabilityLevel,
      'FULL_TOOL_TRACE',
      'Cursor upgrades to FULL_TOOL_TRACE only when file read and commands hooks are verified'
    );

    console.log('  ✔ CursorAdapter strictly defaults to SIFTR_CALLS_ONLY and requires verified hooks to upgrade');
  }

  // ---------------------------------------------------------------------------
  // 5. Downstream Outcome-Evidence Truth Alignment (Section 23 & 31)
  // ---------------------------------------------------------------------------
  console.log('\n--- 5. Downstream Outcome-Evidence Truth Alignment ---');
  {
    const uninspectedUnitExposure = createExposureDecisionV2({
      contextUnitId: 'unit_candidate_uninspected',
      eligibleForSelection: true,
      selected: true,
      resolution: ContextResolution.BODY,
      contextPlanId: 'cplan_truth_test',
    });

    // Case 1: Uninspected unit under default MCP adapter (SIFTR_CALLS_ONLY)
    const defaultMcp = new GenericMcpAdapter();
    const mcpOutcome = computeLabelEvidence({
      exposure: uninspectedUnitExposure,
      observabilityLevel: defaultMcp.observabilityLevel,
      observedBehavior: { read: false, edited: false },
      taskSucceeded: true,
    });
    assert.strictEqual(
      mcpOutcome.outcomeLabel,
      'UNKNOWN',
      'Default MCP must never generate false negative for uninspected unit'
    );

    // Case 2: Uninspected unit under verified full tool trace (FULL_TOOL_TRACE)
    const verifiedClaude = new ClaudeCodeAdapter({ fileReads: true, fileEdits: true, shellCommands: true });
    const fullOutcome = computeLabelEvidence({
      exposure: uninspectedUnitExposure,
      observabilityLevel: verifiedClaude.observabilityLevel,
      observedBehavior: { read: false, edited: false },
      taskSucceeded: true,
    });
    assert.strictEqual(
      fullOutcome.outcomeLabel,
      'WEAK_NEGATIVE',
      'Verified full tool trace in successful task correctly yields WEAK_NEGATIVE'
    );

    console.log('  ✔ Outcome labeling plane directly benefits from truthful observability levels');
  }

  console.log('\n🎉 All Agent Observability Truth tests passed successfully!');
}

if (require.main === module) {
  runAgentObservabilityTruthTests().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
  });
}
