import * as crypto from 'crypto';

export type EnvironmentProvenanceSource =
  | 'USER_SUPPLIED'
  | 'AGENT_REPORTED'
  | 'DETECTED'
  | 'UNKNOWN';

export interface EnvironmentField<T> {
  value: T | null;
  source: EnvironmentProvenanceSource;
}

export interface AgentEnvironmentProvenance {
  agentProvider?: EnvironmentField<string>;
  agentVersion?: EnvironmentField<string>;
  model?: EnvironmentField<string>;
  modelVersion?: EnvironmentField<string>;
  harnessVersion?: EnvironmentField<string>;
  reasoningMode?: EnvironmentField<string>;
  availableTools?: EnvironmentField<string[]>;
  maxTurns?: EnvironmentField<number>;
}

export interface ToolAvailability {
  name: string;
  source: 'BENCHMARK_CONFIG' | 'AGENT_HANDSHAKE' | 'USER_SUPPLIED' | 'DETECTED';
}

export interface AgentEnvironment {
  agentProvider: string;
  agentVersion: string;
  model: string;
  modelVersion?: string;
  harnessVersion: string;
  reasoningMode?: string;
  availableTools: string[];
  toolAvailabilities?: ToolAvailability[];
  maxTurns?: number;
  systemConfigurationHash: string;
  provenance?: AgentEnvironmentProvenance;
}

export function createEnvironmentField<T>(
  value: T | null | undefined,
  source: EnvironmentProvenanceSource = 'UNKNOWN'
): EnvironmentField<T> {
  const isPresent = value !== undefined && value !== null && value !== 'unknown';
  return {
    value: value !== undefined ? (value as T) : null,
    source: isPresent ? source : 'UNKNOWN',
  };
}

export function computeEnvironmentHash(env: Partial<Omit<AgentEnvironment, 'systemConfigurationHash'>>): string {
  const content = JSON.stringify({
    agentProvider: env.agentProvider || 'unknown',
    agentVersion: env.agentVersion || 'unknown',
    model: env.model || 'unknown',
    modelVersion: env.modelVersion || '',
    harnessVersion: env.harnessVersion || 'unknown',
    reasoningMode: env.reasoningMode || '',
    availableTools: env.availableTools ? [...env.availableTools].sort() : [],
    maxTurns: env.maxTurns ?? null,
  });

  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export interface CreateAgentEnvironmentParams {
  agentProvider?: string;
  agentVersion?: string;
  model?: string;
  modelVersion?: string;
  harnessVersion?: string;
  reasoningMode?: string;
  availableTools?: string[];
  maxTurns?: number;
  systemConfigurationHash?: string;
  provenance?: AgentEnvironmentProvenance;
}

export function createAgentEnvironment(
  params: CreateAgentEnvironmentParams = {}
): AgentEnvironment {
  const agentProvider = params.agentProvider || 'unknown';
  const agentVersion = params.agentVersion || 'unknown';
  const model = params.model || 'unknown';
  const harnessVersion = params.harnessVersion || 'unknown';
  const availableTools = params.availableTools ? [...params.availableTools] : [];

  const resolvedParams = {
    agentProvider,
    agentVersion,
    model,
    modelVersion: params.modelVersion,
    harnessVersion,
    reasoningMode: params.reasoningMode,
    availableTools,
    maxTurns: params.maxTurns,
  };

  const systemConfigurationHash =
    params.systemConfigurationHash || computeEnvironmentHash(resolvedParams);

  const provenance: AgentEnvironmentProvenance = params.provenance || {
    agentProvider: createEnvironmentField(
      params.agentProvider,
      params.agentProvider && params.agentProvider !== 'unknown' ? 'USER_SUPPLIED' : 'UNKNOWN'
    ),
    agentVersion: createEnvironmentField(
      params.agentVersion,
      params.agentVersion && params.agentVersion !== 'unknown' ? 'USER_SUPPLIED' : 'UNKNOWN'
    ),
    model: createEnvironmentField(
      params.model,
      params.model && params.model !== 'unknown' ? 'USER_SUPPLIED' : 'UNKNOWN'
    ),
    modelVersion: params.modelVersion !== undefined
      ? createEnvironmentField(params.modelVersion, 'USER_SUPPLIED')
      : undefined,
    harnessVersion: createEnvironmentField(
      params.harnessVersion,
      params.harnessVersion && params.harnessVersion !== 'unknown' ? 'USER_SUPPLIED' : 'UNKNOWN'
    ),
    reasoningMode: params.reasoningMode !== undefined
      ? createEnvironmentField(params.reasoningMode, 'USER_SUPPLIED')
      : undefined,
    availableTools: createEnvironmentField(
      params.availableTools,
      params.availableTools && params.availableTools.length > 0 ? 'USER_SUPPLIED' : 'UNKNOWN'
    ),
    maxTurns: params.maxTurns !== undefined
      ? createEnvironmentField(params.maxTurns, 'USER_SUPPLIED')
      : undefined,
  };

  return {
    ...resolvedParams,
    systemConfigurationHash,
    provenance,
  };
}
