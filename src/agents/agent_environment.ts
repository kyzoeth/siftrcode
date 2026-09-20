import * as crypto from 'crypto';

export interface AgentEnvironment {
  agentProvider: string;
  agentVersion: string;
  model: string;
  modelVersion?: string;
  harnessVersion: string;
  reasoningMode?: string;
  availableTools: string[];
  maxTurns?: number;
  systemConfigurationHash: string;
}

export function computeEnvironmentHash(env: Omit<AgentEnvironment, 'systemConfigurationHash'>): string {
  const content = JSON.stringify({
    agentProvider: env.agentProvider,
    agentVersion: env.agentVersion,
    model: env.model,
    modelVersion: env.modelVersion || '',
    harnessVersion: env.harnessVersion,
    reasoningMode: env.reasoningMode || '',
    availableTools: [...env.availableTools].sort(),
    maxTurns: env.maxTurns ?? null,
  });

  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function createAgentEnvironment(
  params: Omit<AgentEnvironment, 'systemConfigurationHash'> & { systemConfigurationHash?: string }
): AgentEnvironment {
  const systemConfigurationHash =
    params.systemConfigurationHash || computeEnvironmentHash(params);

  return {
    agentProvider: params.agentProvider,
    agentVersion: params.agentVersion,
    model: params.model,
    modelVersion: params.modelVersion,
    harnessVersion: params.harnessVersion,
    reasoningMode: params.reasoningMode,
    availableTools: [...params.availableTools],
    maxTurns: params.maxTurns,
    systemConfigurationHash,
  };
}
