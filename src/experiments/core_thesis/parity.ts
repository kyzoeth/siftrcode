import { ExperimentParityFingerprint, ExperimentIntegrityViolation, sha256Canonical } from './domain';

export interface ParityInputs {
  sourceBaseCommit: string;
  agentConfig: unknown;
  modelConfig: unknown;
  toolConfig: unknown;
  verificationConfig: unknown;
  executionBudget: unknown;
  workspaceStateSha256: string;
  contextPolicyId: string;
}

export function createParityFingerprint(input: ParityInputs): ExperimentParityFingerprint {
  return {
    sourceBaseCommit: input.sourceBaseCommit,
    agentConfigSha256: sha256Canonical(input.agentConfig),
    modelConfigSha256: sha256Canonical(input.modelConfig),
    toolConfigSha256: sha256Canonical(input.toolConfig),
    verificationConfigSha256: sha256Canonical(input.verificationConfig),
    executionBudgetSha256: sha256Canonical(input.executionBudget),
    workspaceStateSha256: input.workspaceStateSha256,
    contextPolicyId: input.contextPolicyId,
  };
}

export function assertPairedParity(
  control: ExperimentParityFingerprint,
  treatment: ExperimentParityFingerprint
): void {
  const violations: ExperimentIntegrityViolation[] = [];
  const fields: Array<keyof ExperimentParityFingerprint> = [
    'sourceBaseCommit',
    'agentConfigSha256',
    'modelConfigSha256',
    'toolConfigSha256',
    'verificationConfigSha256',
    'executionBudgetSha256',
    'workspaceStateSha256',
  ];
  for (const field of fields) {
    if (control[field] !== treatment[field]) {
      violations.push({
        code: `PARITY_MISMATCH_${String(field).toUpperCase()}`,
        message: `${field} differs between CONTROL and SIFTRCODE.`,
      });
    }
  }
  if (control.contextPolicyId === treatment.contextPolicyId) {
    violations.push({
      code: 'PARITY_CONTEXT_POLICY_NOT_MANIPULATED',
      message: 'Paired arms unexpectedly use the same context policy.',
    });
  }
  if (violations.length > 0) {
    const err: any = new Error(
      `FAIL_CLOSED_EXPERIMENT_PARITY: ${violations.map((v) => v.code).join(', ')}`
    );
    err.code = 'FAIL_CLOSED_EXPERIMENT_PARITY';
    err.violations = violations;
    throw err;
  }
}
