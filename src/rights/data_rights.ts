export enum DataClass {
  RAW_SOURCE = 'RAW_SOURCE',
  SOURCE_SNIPPET = 'SOURCE_SNIPPET',
  SYMBOL_NAME = 'SYMBOL_NAME',
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

export interface DataRights {
  remoteProcessingAllowed: boolean;
  telemetryAllowed: boolean;
  trainingAllowed: boolean;
  rawSourceRetentionAllowed: boolean;
  sourceSnippetRetentionAllowed: boolean;
  symbolMetadataAllowed: boolean;
  embeddingsRetentionAllowed: boolean;
  graphRetentionAllowed: boolean;
  derivedNumericFeaturesAllowed: boolean;
  trajectoryRetentionAllowed: boolean;
  retentionDays?: number;
}

/**
 * Creates default data rights enforcing privacy-by-default.
 * In accordance with Section 78: customer proprietary source != training data.
 */
export function createDefaultDataRights(overrides: Partial<DataRights> = {}): DataRights {
  return {
    remoteProcessingAllowed: false,
    telemetryAllowed: true,
    trainingAllowed: false,
    rawSourceRetentionAllowed: false,
    sourceSnippetRetentionAllowed: false,
    symbolMetadataAllowed: false,
    embeddingsRetentionAllowed: false,
    graphRetentionAllowed: false,
    derivedNumericFeaturesAllowed: true,
    trajectoryRetentionAllowed: false,
    retentionDays: 30,
    ...overrides,
  };
}

export function isDataClassPermitted(rights: DataRights, dataClass: DataClass): boolean {
  switch (dataClass) {
    case DataClass.RAW_SOURCE:
      return rights.rawSourceRetentionAllowed;
    case DataClass.SOURCE_SNIPPET:
      return rights.sourceSnippetRetentionAllowed;
    case DataClass.SYMBOL_NAME:
      return rights.symbolMetadataAllowed;
    case DataClass.PATH:
      return rights.symbolMetadataAllowed;
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
