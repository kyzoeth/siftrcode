/**
 * SiftrCode V2 - Data Rights & Granular Operation Policies (Final Closure Directive Section 31-33)
 * Distinguishes processing (local/remote) from retention (local/remote) and model training.
 */

export enum DataClass {
  RAW_SOURCE = 'RAW_SOURCE',
  SOURCE_SNIPPET = 'SOURCE_SNIPPET',
  SYMBOL_NAME = 'SYMBOL_NAME',
  SYMBOL_METADATA = 'SYMBOL_METADATA',
  PATH = 'PATH',
  TASK_PROMPT = 'TASK_PROMPT',
  EMBEDDING = 'EMBEDDING',
  GRAPH_TOPOLOGY = 'GRAPH_TOPOLOGY',
  NUMERIC_FEATURE = 'NUMERIC_FEATURE',
  TRAJECTORY = 'TRAJECTORY',
  PATCH = 'PATCH',
  OUTCOME = 'OUTCOME',
  AGGREGATE_STATISTIC = 'AGGREGATE_STATISTIC',
}

export interface DataClassRights {
  processing: {
    local: boolean;
    remote: boolean;
  };
  retention: {
    local: boolean;
    remote: boolean;
  };
  training: boolean;
}

export type OperationType =
  | 'processing_local'
  | 'processing_remote'
  | 'retention_local'
  | 'retention_remote'
  | 'training';

export type OperationRightsPolicy = Record<DataClass, DataClassRights>;

export interface DataRights {
  remoteProcessingAllowed: boolean;
  telemetryAllowed: boolean;
  trainingAllowed: boolean;
  rawSourceRetentionAllowed: boolean;
  sourceSnippetRetentionAllowed: boolean;
  symbolMetadataAllowed: boolean;
  symbolNameRetentionAllowed?: boolean;
  pathRetentionAllowed?: boolean;
  embeddingsRetentionAllowed: boolean;
  graphRetentionAllowed: boolean;
  derivedNumericFeaturesAllowed: boolean;
  trajectoryRetentionAllowed: boolean;
  retentionDays?: number;
  operationRights?: OperationRightsPolicy;
  hasExplicitOperationRights?: boolean;
}

/**
 * Creates default granular OperationRightsPolicy enforcing enterprise privacy defaults.
 * Supports enterprise case (Section 33): remote processing may be allowed while remote retention and training are strictly forbidden.
 */
export function createDefaultOperationRightsPolicy(
  overrides: Partial<Record<DataClass, Partial<DataClassRights>>> = {}
): OperationRightsPolicy {
  const defaultPolicy: OperationRightsPolicy = {
    [DataClass.RAW_SOURCE]: {
      processing: { local: true, remote: false },
      retention: { local: false, remote: false },
      training: false,
    },
    [DataClass.SOURCE_SNIPPET]: {
      processing: { local: true, remote: false },
      retention: { local: false, remote: false },
      training: false,
    },
    [DataClass.SYMBOL_NAME]: {
      processing: { local: true, remote: false },
      retention: { local: true, remote: false },
      training: false,
    },
    [DataClass.SYMBOL_METADATA]: {
      processing: { local: true, remote: false },
      retention: { local: true, remote: false },
      training: false,
    },
    [DataClass.PATH]: {
      processing: { local: true, remote: false },
      retention: { local: true, remote: false },
      training: false,
    },
    [DataClass.TASK_PROMPT]: {
      processing: { local: true, remote: false },
      retention: { local: true, remote: false },
      training: false,
    },
    [DataClass.EMBEDDING]: {
      processing: { local: true, remote: false },
      retention: { local: false, remote: false },
      training: false,
    },
    [DataClass.GRAPH_TOPOLOGY]: {
      processing: { local: true, remote: false },
      retention: { local: false, remote: false },
      training: false,
    },
    [DataClass.NUMERIC_FEATURE]: {
      processing: { local: true, remote: true },
      retention: { local: true, remote: false },
      training: false,
    },
    [DataClass.TRAJECTORY]: {
      processing: { local: true, remote: false },
      retention: { local: false, remote: false },
      training: false,
    },
    [DataClass.PATCH]: {
      processing: { local: true, remote: false },
      retention: { local: false, remote: false },
      training: false,
    },
    [DataClass.OUTCOME]: {
      processing: { local: true, remote: true },
      retention: { local: true, remote: false },
      training: false,
    },
    [DataClass.AGGREGATE_STATISTIC]: {
      processing: { local: true, remote: true },
      retention: { local: true, remote: true },
      training: false,
    },
  };

  for (const [key, val] of Object.entries(overrides)) {
    const dc = key as DataClass;
    if (defaultPolicy[dc] && val) {
      defaultPolicy[dc] = {
        processing: { ...defaultPolicy[dc].processing, ...val.processing },
        retention: { ...defaultPolicy[dc].retention, ...val.retention },
        training: val.training !== undefined ? val.training : defaultPolicy[dc].training,
      };
    }
  }

  return defaultPolicy;
}

export function isOperationPermitted(
  policy: OperationRightsPolicy,
  dataClass: DataClass,
  operation: OperationType
): boolean {
  const rights = policy[dataClass];
  if (!rights) return false;

  switch (operation) {
    case 'processing_local':
      return rights.processing.local;
    case 'processing_remote':
      return rights.processing.remote;
    case 'retention_local':
      return rights.retention.local;
    case 'retention_remote':
      return rights.retention.remote;
    case 'training':
      return rights.training;
    default:
      return false;
  }
}

/**
 * Creates default data rights enforcing privacy-by-default.
 * In accordance with Section 78: customer proprietary source != training data.
 */
export function createDefaultDataRights(overrides: Partial<DataRights> = {}): DataRights {
  const hasExplicitOperationRights = overrides.operationRights !== undefined;

  const policyOverrides: Partial<Record<DataClass, Partial<DataClassRights>>> = {};
  if (overrides.rawSourceRetentionAllowed !== undefined) {
    policyOverrides[DataClass.RAW_SOURCE] = { retention: { local: overrides.rawSourceRetentionAllowed, remote: false } };
  }
  if (overrides.sourceSnippetRetentionAllowed !== undefined) {
    policyOverrides[DataClass.SOURCE_SNIPPET] = { retention: { local: overrides.sourceSnippetRetentionAllowed, remote: false } };
  }
  if (overrides.symbolNameRetentionAllowed !== undefined) {
    policyOverrides[DataClass.SYMBOL_NAME] = { retention: { local: overrides.symbolNameRetentionAllowed, remote: false } };
  }
  if (overrides.symbolMetadataAllowed !== undefined) {
    policyOverrides[DataClass.SYMBOL_METADATA] = { retention: { local: overrides.symbolMetadataAllowed, remote: false } };
  }
  if (overrides.pathRetentionAllowed !== undefined) {
    policyOverrides[DataClass.PATH] = { retention: { local: overrides.pathRetentionAllowed, remote: false } };
  }
  if (overrides.embeddingsRetentionAllowed !== undefined) {
    policyOverrides[DataClass.EMBEDDING] = { retention: { local: overrides.embeddingsRetentionAllowed, remote: false } };
  }
  if (overrides.graphRetentionAllowed !== undefined) {
    policyOverrides[DataClass.GRAPH_TOPOLOGY] = { retention: { local: overrides.graphRetentionAllowed, remote: false } };
  }
  if (overrides.derivedNumericFeaturesAllowed !== undefined) {
    policyOverrides[DataClass.NUMERIC_FEATURE] = { retention: { local: overrides.derivedNumericFeaturesAllowed, remote: false } };
  }
  if (overrides.trajectoryRetentionAllowed !== undefined) {
    policyOverrides[DataClass.TRAJECTORY] = { retention: { local: overrides.trajectoryRetentionAllowed, remote: false } };
  }
  if (overrides.trainingAllowed !== undefined) {
    for (const dc of Object.values(DataClass)) {
      policyOverrides[dc] = { ...(policyOverrides[dc] || {}), training: overrides.trainingAllowed };
    }
  }

  const operationRights = overrides.operationRights || createDefaultOperationRightsPolicy(policyOverrides);

  return {
    remoteProcessingAllowed: false,
    telemetryAllowed: true,
    trainingAllowed: false,
    rawSourceRetentionAllowed: false,
    sourceSnippetRetentionAllowed: false,
    symbolMetadataAllowed: true,
    symbolNameRetentionAllowed: true,
    pathRetentionAllowed: true,
    embeddingsRetentionAllowed: false,
    graphRetentionAllowed: false,
    derivedNumericFeaturesAllowed: true,
    trajectoryRetentionAllowed: false,
    retentionDays: 30,
    ...overrides,
    operationRights,
    hasExplicitOperationRights,
  };
}

export function isDataClassPermitted(rights: DataRights, dataClass: DataClass): boolean {
  // Authoritative check across every durable write:
  // operationRights.*.retention.local takes precedence over legacy flat flags
  if (rights.operationRights && rights.operationRights[dataClass]?.retention?.local !== undefined) {
    if (rights.hasExplicitOperationRights !== false) {
      return rights.operationRights[dataClass].retention.local;
    }
  }

  // Legacy flat flags as backward-compatible fallback
  switch (dataClass) {
    case DataClass.RAW_SOURCE:
      return rights.rawSourceRetentionAllowed;
    case DataClass.SOURCE_SNIPPET:
      return rights.sourceSnippetRetentionAllowed;
    case DataClass.SYMBOL_NAME:
      return rights.symbolNameRetentionAllowed !== undefined
        ? rights.symbolNameRetentionAllowed
        : rights.symbolMetadataAllowed;
    case DataClass.SYMBOL_METADATA:
      return rights.symbolMetadataAllowed;
    case DataClass.PATH:
      return rights.pathRetentionAllowed !== undefined
        ? rights.pathRetentionAllowed
        : rights.symbolMetadataAllowed;
    case DataClass.TASK_PROMPT:
      return rights.telemetryAllowed;
    case DataClass.EMBEDDING:
      return rights.embeddingsRetentionAllowed;
    case DataClass.GRAPH_TOPOLOGY:
      return rights.graphRetentionAllowed;
    case DataClass.NUMERIC_FEATURE:
      return rights.derivedNumericFeaturesAllowed;
    case DataClass.TRAJECTORY:
      return rights.trajectoryRetentionAllowed;
    case DataClass.PATCH:
      return rights.telemetryAllowed;
    case DataClass.OUTCOME:
      return rights.telemetryAllowed;
    case DataClass.AGGREGATE_STATISTIC:
      return true;
    default:
      return false;
  }
}

/**
 * Checks whether remote processing is permitted for an outbound DataClass.
 * Gated strictly through processing.remote (Part VI Section 14), distinct from retention rights.
 */
export function isRemoteProcessingPermitted(rights: DataRights, dataClass: DataClass): boolean {
  if (!rights.remoteProcessingAllowed) {
    return false;
  }
  // Granular operation-rights policy must always be present before enabling remote processing (fail-closed).
  if (!rights.operationRights) {
    return false;
  }
  return isOperationPermitted(rights.operationRights, dataClass, 'processing_remote');
}

/**
 * Translates application/environment configuration into explicit DataRights.
 * When remote JEV processing is enabled in environment or configuration, translates it strictly to
 * createJevPermittedDataRights()—never to a blanket global allow.
 */
export function resolveApplicationDataRights(configuredRights?: DataRights): DataRights {
  if (configuredRights) {
    // If remote processing is enabled on configuredRights, verify that operationRights is present;
    // if missing, translate to createJevPermittedDataRights to avoid blanket global allows.
    if (configuredRights.remoteProcessingAllowed && !configuredRights.operationRights) {
      return createJevPermittedDataRights(configuredRights);
    }
    return configuredRights;
  }

  // Check explicit V2 JEV remote-processing configuration (e.g. at Railway boundary).
  // SIFTR_JEV_ENABLED alone does NOT grant outbound processing; only explicit SIFTR_JEV_REMOTE_PROCESSING grants remote rights.
  const jevRemoteEnabled = process.env.SIFTR_JEV_REMOTE_PROCESSING === 'true';

  if (jevRemoteEnabled) {
    return createJevPermittedDataRights();
  }

  return createDefaultDataRights();
}

/**
 * Creates DataRights permitting remote processing for JEV candidate evaluation
 * while strictly prohibiting remote retention and model training (Directive Section 15).
 */
export function createJevPermittedDataRights(overrides: Partial<DataRights> = {}): DataRights {
  const jevPolicy = createDefaultOperationRightsPolicy({
    [DataClass.TASK_PROMPT]: { processing: { local: true, remote: true } },
    [DataClass.SYMBOL_NAME]: { processing: { local: true, remote: true } },
    [DataClass.SYMBOL_METADATA]: { processing: { local: true, remote: true } },
    [DataClass.PATH]: { processing: { local: true, remote: true } },
    [DataClass.NUMERIC_FEATURE]: { processing: { local: true, remote: true } },
  });

  const { operationRights: explicitOpRights, ...safeOverrides } = overrides;

  return createDefaultDataRights({
    remoteProcessingAllowed: true,
    ...safeOverrides,
    operationRights: explicitOpRights || jevPolicy,
    hasExplicitOperationRights: true,
  });
}
