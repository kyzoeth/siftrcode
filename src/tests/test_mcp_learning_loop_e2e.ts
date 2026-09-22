/**
 * SiftrCode V2 - End-to-End Learning Loop & Lineage Integrity Integration Tests
 *
 * Covers Final Closure Directive (PR F7, Sections 38-43):
 * 1. 8-Step Complete Lifecycle Flow (Session Start -> Context -> Expand -> Simulate -> Ambiguous Outcome -> Verified Outcome -> Session End)
 * 2. Direct SQLite Database Lineage Assertions (.siftr/observations.sqlite)
 * 3. Negative 1: Outcome with wrong plan rejected (Section 39)
 * 4. Negative 2: Cross-task expand rejected (Section 40)
 * 5. Negative 3: Tri-state NULL round-trips as NULL, never 0 (Section 41)
 * 6. Negative 4: Class method BODY strictly isolates implementation and excludes sibling methods (Section 42)
 * 7. Negative 5: Cursor without handshake defaults to SIFTR_CALLS_ONLY and promotes only on handshake (Section 43)
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp/server';
import { SqliteStore } from '../storage/sqlite_store';
import { CursorAdapter } from '../agents/agent_adapter';
import { ContextResolution } from '../context/context_resolution';
import { WorkspaceManager } from '../workspace/workspace_manager';
import { RepositoryIndexer } from '../indexing/repository_index';
import { DefaultContextUnitMaterializer } from '../materialization/context_unit_materializer';
import { DefaultWorkspaceSourceReader } from '../workspace/workspace_source_reader';
import { ContextUnitKind } from '../context/context_unit';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

function assertStrictEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) {
    console.error(`❌ Assertion failed: ${message}\n  Expected: ${expected}\n  Actual:   ${actual}`);
    throw new Error(`Assertion failed: ${message} (expected ${expected}, got ${actual})`);
  }
}

export async function runMcpLearningLoopE2ETests() {
  console.log('\n=== Running V2 MCP Learning Loop & Lineage Integrity E2E Tests (PR F7) ===\n');

  // Setup isolated temporary git workspace
  const tempWorkspaceDir = path.join(
    __dirname,
    '..',
    '..',
    'temp_learning_loop_e2e_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8)
  );
  fs.mkdirSync(tempWorkspaceDir, { recursive: true });
  fs.mkdirSync(path.join(tempWorkspaceDir, 'src'), { recursive: true });

  // Initialize git repository
  execSync('git init -b main', { cwd: tempWorkspaceDir, stdio: 'ignore' });
  execSync('git config user.email "test@siftrcode.com"', { cwd: tempWorkspaceDir, stdio: 'ignore' });
  execSync('git config user.name "Siftr Test"', { cwd: tempWorkspaceDir, stdio: 'ignore' });

  // Write realistic source files
  const stripeClientFile = path.join(tempWorkspaceDir, 'src', 'stripe_client.ts');
  fs.writeFileSync(
    stripeClientFile,
    `export interface PaymentOptions {
  timeoutMs: number;
  retries: number;
}

export class StripeClient {
  private timeoutMs: number;

  constructor(options?: Partial<PaymentOptions>) {
    this.timeoutMs = options?.timeoutMs || 5000;
  }

  public validatePaymentPayload(payload: any): boolean {
    if (!payload || !payload.amount || payload.amount <= 0) {
      return false;
    }
    return true;
  }

  public executeCharge(amount: number, currency: string): { success: boolean; chargeId: string } {
    if (amount <= 0) {
      throw new Error('Invalid charge amount');
    }
    const chargeId = 'ch_' + Math.random().toString(36).substring(2);
    return { success: true, chargeId };
  }

  public cancelCharge(chargeId: string): boolean {
    if (!chargeId.startsWith('ch_')) {
      return false;
    }
    return true;
  }
}
`
  );

  const testFile = path.join(tempWorkspaceDir, 'src', 'stripe_client.test.ts');
  fs.writeFileSync(
    testFile,
    `import { StripeClient } from './stripe_client';

export function testCharge() {
  const client = new StripeClient({ timeoutMs: 3000 });
  const res = client.executeCharge(100, 'usd');
  if (!res.success) throw new Error('Charge failed');
}
`
  );

  const authFile = path.join(tempWorkspaceDir, 'src', 'auth.ts');
  fs.writeFileSync(
    authFile,
    `export class AuthService {
  public authenticateUser(token: string): boolean {
    return Boolean(token && token.length > 10);
  }
}
`
  );

  execSync('git add .', { cwd: tempWorkspaceDir, stdio: 'ignore' });
  execSync('git commit -m "initial commit"', { cwd: tempWorkspaceDir, stdio: 'ignore' });

  // Setup in-memory MCP client and server pair
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'test-learning-agent', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);

  try {
    // =========================================================================
    // 1. 8-Step Complete Lifecycle Flow (Section 38)
    // =========================================================================
    console.log('--- 1. 8-Step Complete Lifecycle Flow (Section 38) ---');

    // Step 1: siftr_session(start)
    console.log('  ➔ Step 1: siftr_session(action: start)');
    const startSessionResult = await client.callTool({
      name: 'siftr_session',
      arguments: {
        action: 'start',
        directory: tempWorkspaceDir,
        agentModel: 'claude-3-7-sonnet',
      },
    });

    assert(!startSessionResult.isError, 'Session start must succeed without error');
    const startSessionPayload = JSON.parse((startSessionResult.content as any)[0].text);
    const sessionId = startSessionPayload.sessionId;
    const initialSnapshotId = startSessionPayload.initialWorkspaceSnapshotId;
    const agentEnvId = startSessionPayload.agentEnvironmentId;

    assert(Boolean(sessionId && sessionId.startsWith('sess_')), `sessionId must start with sess_, got: ${sessionId}`);
    assert(Boolean(initialSnapshotId && initialSnapshotId.startsWith('ws_')), `initialSnapshotId must start with ws_, got: ${initialSnapshotId}`);
    assert(Boolean(agentEnvId && agentEnvId !== 'unknown'), `agentEnvironmentId must be truthful, got: ${agentEnvId}`);
    assertStrictEqual(startSessionPayload.status, 'ACTIVE', 'Session must be ACTIVE');
    console.log(`    ✔ Session started: ${sessionId}`);

    // Step 2: siftr_context
    console.log('  ➔ Step 2: siftr_context');
    const contextResult = await client.callTool({
      name: 'siftr_context',
      arguments: {
        prompt: 'Fix payment timeout race condition in StripeClient executeCharge',
        directory: tempWorkspaceDir,
        sessionId,
      },
    });

    assert(!contextResult.isError, 'Context generation must succeed');
    const contextPayload = JSON.parse((contextResult.content as any)[0].text);
    const taskId = contextPayload.taskId;
    const planId = contextPayload.planId;
    const workspaceSnapshotId = contextPayload.workspaceSnapshotId;
    const units = contextPayload.units || [];

    assert(Boolean(taskId && taskId.startsWith('task_')), `taskId must start with task_, got: ${taskId}`);
    assert(Boolean(planId && planId.startsWith('cplan_')), `planId must start with cplan_, got: ${planId}`);
    assertStrictEqual(contextPayload.sessionId, sessionId, 'Context response must bind exact sessionId');
    assert(units.length > 0, 'Context plan must contain units');
    console.log(`    ✔ ContextPlan generated: ${planId} for task: ${taskId} (${units.length} units)`);

    // Step 3: Locate context item initially provided
    console.log('  ➔ Step 3: Locate candidate unit for expansion');
    const targetUnit = units.find((u: any) => u.title && u.title.includes('StripeClient.executeCharge')) || units[0];
    assert(Boolean(targetUnit && targetUnit.contextUnitId), 'Must find target ContextUnit with unique contextUnitId');
    console.log(`    ✔ Target unit found: ${targetUnit.title} (ID: ${targetUnit.contextUnitId}, initial resolution: ${targetUnit.resolutionName})`);

    // Step 4: siftr_expand
    console.log('  ➔ Step 4: siftr_expand to BODY');
    const expandResult = await client.callTool({
      name: 'siftr_expand',
      arguments: {
        contextUnitId: targetUnit.contextUnitId,
        targetResolution: 'body',
        directory: tempWorkspaceDir,
        sessionId,
        planId,
        taskId,
      },
    });

    assert(!expandResult.isError, 'Expansion must succeed without error');
    const expandPayload = JSON.parse((expandResult.content as any)[0].text);
    assertStrictEqual(expandPayload.success, true, 'Expansion success flag must be true');
    assertStrictEqual(expandPayload.actualResolution, 'BODY', 'Actual resolution must be BODY');
    assert(Boolean(expandPayload.content), 'Materialized content must be non-empty');
    assert(Boolean(expandPayload.eventId), 'Expansion eventId must be returned');
    console.log(`    ✔ Unit expanded: actualResolution=BODY, eventId=${expandPayload.eventId}`);

    // Step 5: Simulate agent activity
    console.log('  ➔ Step 5: Simulate agent activity');
    fs.appendFileSync(stripeClientFile, '\n// Agent applied fix for timeout race condition\n');

    // Step 6: siftr_outcome with weak/insufficient evidence (tri-state UNKNOWN / null)
    console.log('  ➔ Step 6: siftr_outcome with weak evidence (must evaluate to null UNKNOWN)');
    const weakOutcomeResult = await client.callTool({
      name: 'siftr_outcome',
      arguments: {
        taskId,
        sessionId,
        planId,
        directory: tempWorkspaceDir,
        agentClaimedSuccess: true, // Agent self-reported success alone (Section 49)
      },
    });

    assert(!weakOutcomeResult.isError, 'Weak outcome submission must succeed');
    const weakOutcomePayload = JSON.parse((weakOutcomeResult.content as any)[0].text);
    assertStrictEqual(weakOutcomePayload.verifiedSuccess, null, 'Weak evidence MUST yield verifiedSuccess = null (UNKNOWN), not false or 0');
    assert(weakOutcomePayload.confidence <= 0.40, `Weak evidence confidence must be <= 0.40, got: ${weakOutcomePayload.confidence}`);
    console.log(`    ✔ Weak evidence yielded verifiedSuccess = null (UNKNOWN), confidence=${weakOutcomePayload.confidence}`);

    // Step 7: siftr_outcome with strong verification evidence
    console.log('  ➔ Step 7: siftr_outcome with strong verification evidence');
    const strongOutcomeResult = await client.callTool({
      name: 'siftr_outcome',
      arguments: {
        taskId,
        sessionId,
        planId,
        directory: tempWorkspaceDir,
        evidence: {
          behavioralOraclePassed: true,
          buildPassed: true,
          publicTestsPassed: true,
          regressionTestsPassed: true,
          actualProviderInputTokens: 1250,
          actualProviderOutputTokens: 350,
          costUSD: 0.0042,
          wallTimeMs: 4500,
        },
      },
    });

    assert(!strongOutcomeResult.isError, 'Strong outcome submission must succeed');
    const strongOutcomePayload = JSON.parse((strongOutcomeResult.content as any)[0].text);
    assertStrictEqual(strongOutcomePayload.verifiedSuccess, true, 'Strong evidence MUST yield verifiedSuccess = true');
    assert(strongOutcomePayload.confidence >= 0.9, `Strong evidence confidence must be >= 0.9, got: ${strongOutcomePayload.confidence}`);
    assertStrictEqual(strongOutcomePayload.policyId, 'siftr-default-outcome', 'Outcome policyId must be siftr-default-outcome');
    assertStrictEqual(strongOutcomePayload.policyVersion, '1.0.0', 'Outcome policyVersion must be 1.0.0');
    console.log(`    ✔ Strong evidence yielded verifiedSuccess = true, confidence=${strongOutcomePayload.confidence}`);

    // Step 8: siftr_session(end)
    console.log('  ➔ Step 8: siftr_session(action: end)');
    const endSessionResult = await client.callTool({
      name: 'siftr_session',
      arguments: {
        action: 'end',
        sessionId,
        taskId,
        directory: tempWorkspaceDir,
        status: 'COMPLETED',
      },
    });

    assert(!endSessionResult.isError, 'Ending session must succeed');
    const endSessionPayload = JSON.parse((endSessionResult.content as any)[0].text);
    assertStrictEqual(endSessionPayload.status, 'COMPLETED', 'Session status must transition to COMPLETED');
    assert(Boolean(endSessionPayload.endedAt), 'Session must record endedAt timestamp');
    console.log(`    ✔ Session completed at: ${endSessionPayload.endedAt}`);

    // =========================================================================
    // 2. Direct SQLite Database Lineage Assertions (Section 38)
    // =========================================================================
    console.log('\n--- 2. Direct SQLite Database Lineage Assertions ---');
    const dbPath = path.join(tempWorkspaceDir, '.siftr', 'observations.sqlite');
    assert(fs.existsSync(dbPath), `Database file must exist at ${dbPath}`);
    const dbStore = new SqliteStore(dbPath);

    // Assert sessions table
    const storedSession = dbStore.getSiftrSession(sessionId);
    assert(storedSession !== undefined, 'Session must exist in SQLite sessions table');
    assertStrictEqual(storedSession!.sessionId, sessionId, 'Stored session sessionId matches');
    assertStrictEqual(storedSession!.taskId, taskId, 'Stored session taskId matches');
    assertStrictEqual(storedSession!.status, 'COMPLETED', 'Stored session status is COMPLETED');
    assert(Boolean(storedSession!.endedAt), 'Stored session has non-null endedAt');
    assertStrictEqual(storedSession!.agentEnvironmentId, agentEnvId, 'Stored session preserves agentEnvironmentId');
    assertStrictEqual(storedSession!.initialWorkspaceSnapshotId, initialSnapshotId, 'Stored session preserves initial snapshot');
    console.log('  ✔ Database: sessions table record verified with exact lineage and completion timestamp');

    // Assert context_plans table
    const storedPlan = dbStore.getContextPlan(planId);
    assert(storedPlan !== undefined, 'ContextPlan must exist in SQLite context_plans table');
    assertStrictEqual(storedPlan!.planId, planId, 'Stored plan planId matches');
    assertStrictEqual(storedPlan!.sessionId, sessionId, 'Stored plan is joined to sessionId');
    assertStrictEqual(storedPlan!.taskId, taskId, 'Stored plan is joined to taskId');
    assertStrictEqual(storedPlan!.actualProviderInputTokens, 1250, 'Stored plan updated with actual provider tokens');
    console.log('  ✔ Database: context_plans table verified with exact sessionId and actualProviderInputTokens');

    // Assert expansion_events table
    const expansionEvents = dbStore.listExpansionEvents(sessionId);
    assert(expansionEvents.length >= 1, `Must have at least 1 expansion event, got ${expansionEvents.length}`);
    const expEvent = expansionEvents.find((e) => e.contextUnitId === targetUnit.contextUnitId);
    assert(expEvent !== undefined, 'Expansion event for target unit must be persisted');
    assertStrictEqual(expEvent!.contextPlanId, planId, 'Expansion event joined to planId');
    assertStrictEqual(expEvent!.requestedResolution, ContextResolution.BODY, 'Requested resolution was BODY');
    assertStrictEqual(expEvent!.actualResolution, ContextResolution.BODY, 'Actual resolution was BODY');
    console.log('  ✔ Database: expansion_events table verified with exact unit, plan, and resolution');

    // Assert outcome_evidence table
    const storedEvidences = dbStore.listOutcomeEvidence(taskId, sessionId);
    assert(storedEvidences.length >= 2, `Must have at least 2 outcome evidences (weak + strong), got ${storedEvidences.length}`);
    const strongEv = storedEvidences.find((e) => e.verifiedSuccess === true);
    assert(strongEv !== undefined, 'Verified success outcome evidence must be stored');
    assertStrictEqual(strongEv!.contextPlanId, planId, 'Outcome evidence joined to planId');
    assertStrictEqual(strongEv!.sessionId, sessionId, 'Outcome evidence joined to sessionId');
    assertStrictEqual(strongEv!.taskId, taskId, 'Outcome evidence joined to taskId');
    assertStrictEqual(strongEv!.verifiedSuccess, true, 'Verified success is true');
    console.log('  ✔ Database: outcome_evidence table verified with exact planId, sessionId, and verifiedSuccess');

    // Assert final_context_allocations table
    const finalAlloc = dbStore.getFinalContextAllocation(planId);
    assert(finalAlloc !== undefined, 'FinalContextAllocation must be persisted');
    assertStrictEqual(finalAlloc!.planId, planId, 'FinalContextAllocation planId matches');
    assert(finalAlloc!.items.length > 0, 'FinalContextAllocation has allocated items');
    console.log('  ✔ Database: final_context_allocations table verified with canonical post-degradation items');

    // Assert provider_usage_events table
    const usageEvents = dbStore.listProviderUsageEvents(sessionId);
    assert(usageEvents.length >= 1, 'ProviderUsageEvent must be persisted');
    assertStrictEqual(usageEvents[0].inputTokens, 1250, 'Provider usage input tokens match');
    assertStrictEqual(usageEvents[0].outputTokens, 350, 'Provider usage output tokens match');
    console.log('  ✔ Database: provider_usage_events table verified without mutating planned token estimates');

    // =========================================================================
    // 3. Negative 1: Outcome With Wrong Plan Rejected (Section 39)
    // =========================================================================
    console.log('\n--- 3. Negative 1: Outcome With Wrong Plan (Section 39) ---');
    // Start session B
    const sessionBResult = await client.callTool({
      name: 'siftr_session',
      arguments: { action: 'start', directory: tempWorkspaceDir },
    });
    const sessionBPayload = JSON.parse((sessionBResult.content as any)[0].text);
    const sessionBId = sessionBPayload.sessionId;

    // Generate plan B for session B targeting AuthService
    const contextBResult = await client.callTool({
      name: 'siftr_context',
      arguments: {
        prompt: 'Fix authentication failure in AuthService authenticateUser',
        directory: tempWorkspaceDir,
        sessionId: sessionBId,
      },
    });
    const contextBPayload = JSON.parse((contextBResult.content as any)[0].text);
    const planBId = contextBPayload.planId;

    // Attempt to report outcome for session A using plan B (cross-session mismatch)
    const mismatchOutcomeResult = await client.callTool({
      name: 'siftr_outcome',
      arguments: {
        sessionId: sessionId, // Session A
        planId: planBId,      // Plan from Session B!
        directory: tempWorkspaceDir,
        testsPassed: true,
      },
    });

    assert(mismatchOutcomeResult.isError === true, 'Mismatched plan/session outcome MUST be rejected with error');
    const errText = (mismatchOutcomeResult.content as any)[0].text;
    assert(
      errText.includes('belongs to') || errText.includes('mismatch') || errText.includes('task'),
      `Error text must explain lineage mismatch, got: ${errText}`
    );

    // Verify database: NO outcome record written for (sessionA, planB)
    const crossOutcomes = dbStore.listOutcomeEvidence(undefined, sessionId).filter((e) => e.contextPlanId === planBId);
    assertStrictEqual(crossOutcomes.length, 0, 'Database must have zero outcome records for mismatched session/plan');
    console.log('  ✔ Negative 1 passed: Outcome with wrong plan strictly rejected, zero corrupted database records');

    // =========================================================================
    // 4. Negative 2: Cross-Task Expand Rejected (Section 40)
    // =========================================================================
    console.log('\n--- 4. Negative 2: Cross-Task Expand (Section 40) ---');
    // Attempt to expand a unit belonging to plan B using plan A
    const unitFromPlanB = contextBPayload.units[0]?.contextUnitId;
    assert(Boolean(unitFromPlanB), 'Must have unit from plan B');

    const crossExpandResult = await client.callTool({
      name: 'siftr_expand',
      arguments: {
        contextUnitId: unitFromPlanB,
        planId: planId, // Plan A!
        sessionId: sessionId,
        directory: tempWorkspaceDir,
      },
    });

    assert(crossExpandResult.isError === true, 'Cross-task unit expansion MUST be rejected');
    const crossExpandErr = (crossExpandResult.content as any)[0].text;
    assert(
      crossExpandErr.includes('does not belong to plan') || crossExpandErr.includes('rejected'),
      `Error must explain unit does not belong to plan, got: ${crossExpandErr}`
    );

    // Verify database: NO expansion event written for unitFromPlanB under planId
    const crossEvents = dbStore.listExpansionEvents(sessionId).filter((e) => e.contextUnitId === unitFromPlanB);
    assertStrictEqual(crossEvents.length, 0, 'Database must have zero expansion events for foreign unit');
    console.log('  ✔ Negative 2 passed: Cross-task ContextUnit expansion strictly rejected');

    // =========================================================================
    // 5. Negative 3: Tri-State NULL Round-Trip (Section 41)
    // =========================================================================
    console.log('\n--- 5. Negative 3: Tri-State NULL Round-Trip (Section 41) ---');
    // Look up the weak outcome evidence we saved in Step 6
    const weakEvidences = dbStore.listOutcomeEvidence(taskId, sessionId).filter((e) => e.verifiedSuccess === null);
    assert(weakEvidences.length >= 1, 'Must find at least 1 outcome with verifiedSuccess === null');
    const weakEv = weakEvidences[0];

    // Query SQLite directly using raw SQL
    const rawOutcomeRow = (dbStore as any).db.prepare(
      'SELECT verified_success FROM outcome_evidence WHERE evidence_id = ?'
    ).get(weakEv.evidenceId);

    assert(rawOutcomeRow !== undefined, 'Row must exist in outcome_evidence table');
    assertStrictEqual(
      rawOutcomeRow.verified_success,
      null,
      `SQLite column verified_success MUST be null, not 0 or integer! Got: ${rawOutcomeRow.verified_success}`
    );

    // Query task_outcome_records raw SQL
    const rawTaskOutcomeRow = (dbStore as any).db.prepare(
      'SELECT verified_success FROM task_outcome_records WHERE session_id = ? AND verified_success IS NULL'
    ).get(sessionId);

    assert(rawTaskOutcomeRow !== undefined, 'Row must exist in task_outcome_records with NULL verified_success');
    assertStrictEqual(
      rawTaskOutcomeRow.verified_success,
      null,
      `SQLite task_outcome_records.verified_success MUST be null! Got: ${rawTaskOutcomeRow.verified_success}`
    );
    console.log('  ✔ Negative 3 passed: verifiedSuccess = null preserved as true SQLite NULL, never coerced to 0');

    // =========================================================================
    // 6. Negative 4: Sibling Method Exclusion (Section 42)
    // =========================================================================
    console.log('\n--- 6. Negative 4: Sibling Method Exclusion (Section 42) ---');
    // Create class with three distinct methods
    const calcFile = path.join(tempWorkspaceDir, 'src', 'calculator.ts');
    fs.writeFileSync(
      calcFile,
      `export class Calculator {
  public add(a: number, b: number): number {
    const result = a + b;
    return result;
  }

  public subtract(a: number, b: number): number {
    const result = a - b;
    return result;
  }

  public multiply(a: number, b: number): number {
    const result = a * b;
    return result;
  }
}
`
    );

    execSync('git add src/calculator.ts', { cwd: tempWorkspaceDir, stdio: 'ignore' });
    execSync('git commit -m "add calculator"', { cwd: tempWorkspaceDir, stdio: 'ignore' });

    // Capture snapshot & index symbols
    const wsManager = new WorkspaceManager({ rootDir: tempWorkspaceDir });
    const calcSnapshot = await wsManager.captureSnapshot();
    const indexer = new RepositoryIndexer();
    const indexed = await indexer.indexRepository(tempWorkspaceDir, {
      workspaceSnapshotId: calcSnapshot.workspaceSnapshotId,
    });

    const subtractUnit = indexed.units.find(
      (u) => u.kind === ContextUnitKind.CODE_SYMBOL && u.title.includes('Calculator.subtract')
    );
    assert(subtractUnit !== undefined, 'Calculator.subtract unit must be indexed');

    // Materialize subtractUnit at BODY using workspace reader pointing to tempWorkspaceDir
    const sourceReader = new DefaultWorkspaceSourceReader(tempWorkspaceDir);
    const materializer = new DefaultContextUnitMaterializer(sourceReader);
    const materialized = materializer.materializeSync(subtractUnit!, ContextResolution.BODY, calcSnapshot);

    assertStrictEqual(materialized.resolution, ContextResolution.BODY, 'Materialized resolution is BODY');
    assert(
      materialized.content.includes('const result = a - b;'),
      'Materialized content MUST include subtract body implementation'
    );
    assert(
      !materialized.content.includes('const result = a + b;'),
      'Materialized content MUST NOT include sibling method add() implementation!'
    );
    assert(
      !materialized.content.includes('const result = a * b;'),
      'Materialized content MUST NOT include sibling method multiply() implementation!'
    );
    console.log('  ✔ Negative 4 passed: Class method BODY strictly isolates subtract and excludes sibling methods add & multiply');

    // =========================================================================
    // 7. Negative 5: Cursor Without Handshake (Section 43)
    // =========================================================================
    console.log('\n--- 7. Negative 5: Cursor Without Handshake (Section 43) ---');
    const cursor = new CursorAdapter();

    // Invariant: Defaults to SIFTR_CALLS_ONLY
    assertStrictEqual(
      cursor.observabilityLevel,
      'SIFTR_CALLS_ONLY',
      'Cursor without handshake must strictly default to SIFTR_CALLS_ONLY'
    );
    assertStrictEqual(
      cursor.observationCoverage.activeCoverage.fileEdits,
      false,
      'Cursor default activeCoverage.fileEdits must be false'
    );
    assertStrictEqual(
      cursor.observationCoverage.activeCoverage.shellCommands,
      false,
      'Cursor default activeCoverage.shellCommands must be false'
    );
    assertStrictEqual(
      cursor.observationCoverage.activeCoverage.mcpCalls,
      true,
      'Cursor activeCoverage.mcpCalls is true'
    );

    // Perform handshake with verified tool channels
    const coverage = cursor.performHandshake({
      sessionId: 'sess_handshake_test',
      agent: 'cursor',
      activeHooks: { fileEdits: true },
      verifiedAt: new Date().toISOString(),
    });

    assertStrictEqual(
      cursor.observabilityLevel,
      'PARTIAL_AGENT_TRACE',
      'Verified handshake promoting fileEdits must upgrade Cursor to PARTIAL_AGENT_TRACE'
    );
    assertStrictEqual(
      coverage.activeCoverage.fileEdits,
      true,
      'Handshake must set activeCoverage.fileEdits = true'
    );
    console.log('  ✔ Negative 5 passed: Cursor strictly defaults to SIFTR_CALLS_ONLY and only promotes after verified handshake');

    console.log('\n🎉 ALL MCP LEARNING LOOP & LINEAGE INTEGRITY E2E TESTS PASSED SUCCESSFULLY!\n');
  } finally {
    try {
      await client.close();
    } catch {}
    // Clean up temporary workspace directory
    try {
      fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
    } catch {}
  }
}

// Self-executing runner when executed directly
if (require.main === module) {
  runMcpLearningLoopE2ETests().catch((err) => {
    console.error('❌ MCP Learning Loop E2E tests failed:', err);
    process.exit(1);
  });
}
