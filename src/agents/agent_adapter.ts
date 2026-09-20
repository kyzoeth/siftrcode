/**
 * SiftrCode V2 - AgentAdapter & Observability Contracts
 * Authoritative interface bridging SiftrCode context allocations to specific AI coding agents.
 */

import { ContextResolution, getResolutionName } from '../context/context_resolution';

export type ObservabilityLevel = 
  | 'SIFTR_CALLS_ONLY' 
  | 'PARTIAL_AGENT_TRACE' 
  | 'FULL_TOOL_TRACE' 
  | 'HARNESS_NATIVE';

export interface AgentCapabilities {
  supportsFileTree: boolean;
  supportsTerminal: boolean;
  supportsTestRunner: boolean;
  supportsLinter: boolean;
  customTools: string[];
}

export interface ToolCallRecord {
  timestamp: number;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface AgentObservation {
  touchedFiles: string[];
  executedCommands: string[];
  encounteredErrors: string[];
  inspectedSymbols: string[];
}

export interface ContextUnitResolved {
  unitId: string;
  title: string;
  filePath?: string;
  resolution: ContextResolution;
  content?: string;
}

export interface FormattedContext {
  promptText: string;
  sections: Array<{
    title: string;
    filePath?: string;
    resolution: ContextResolution;
    content: string;
    unitId?: string;
  }>;
  metadata: Record<string, unknown>;
  tokenEstimate: number;
}

export interface FormattingOptions {
  maxTokens?: number;
  includeInstructions?: boolean;
  instructionPrefix?: string;
}

export interface AgentAdapter {
  id: string;
  name: string;
  capabilities: AgentCapabilities;
  observabilityLevel: ObservabilityLevel;

  formatContext(
    units: ContextUnitResolved[],
    options?: FormattingOptions
  ): FormattedContext;

  parseToolCalls(raw: unknown): ToolCallRecord[];
  extractObservations(toolCalls: ToolCallRecord[]): AgentObservation;
}

/**
 * Base helper to extract generic file and command observations from tool call records.
 */
export function extractGenericObservations(toolCalls: ToolCallRecord[]): AgentObservation {
  const touchedFiles = new Set<string>();
  const executedCommands = new Set<string>();
  const encounteredErrors: string[] = [];
  const inspectedSymbols = new Set<string>();

  for (const call of toolCalls) {
    if (call.error) {
      encounteredErrors.push(`[${call.toolName}] ${call.error}`);
    }

    const args = call.arguments || {};
    // Extract file paths from common tool argument names
    for (const key of ['path', 'filePath', 'file_path', 'file', 'target', 'filename']) {
      if (typeof args[key] === 'string' && args[key]) {
        touchedFiles.add(args[key] as string);
      }
    }

    // Extract commands from bash/terminal tool arguments
    for (const key of ['command', 'cmd', 'script']) {
      if (typeof args[key] === 'string' && args[key]) {
        executedCommands.add(args[key] as string);
      }
    }

    // Extract symbol queries from grep/search/inspect tools
    for (const key of ['symbol', 'query', 'pattern', 'name', 'identifier']) {
      if (typeof args[key] === 'string' && args[key]) {
        inspectedSymbols.add(args[key] as string);
      }
    }
  }

  return {
    touchedFiles: Array.from(touchedFiles),
    executedCommands: Array.from(executedCommands),
    encounteredErrors,
    inspectedSymbols: Array.from(inspectedSymbols),
  };
}

/**
 * Claude Code specialized adapter
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  id = 'claude-code';
  name = 'Claude Code CLI Adapter';
  capabilities: AgentCapabilities = {
    supportsFileTree: true,
    supportsTerminal: true,
    supportsTestRunner: true,
    supportsLinter: true,
    customTools: ['View', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent'],
  };
  observabilityLevel: ObservabilityLevel = 'FULL_TOOL_TRACE';

  formatContext(
    units: ContextUnitResolved[],
    options?: FormattingOptions
  ): FormattedContext {
    const sections: FormattedContext['sections'] = [];
    const lines: string[] = [];

    if (options?.includeInstructions) {
      lines.push('<!-- SiftrCode Context Block: High-Relevance Context Units -->');
      if (options.instructionPrefix) {
        lines.push(options.instructionPrefix);
      }
    }

    for (const unit of units) {
      if (unit.resolution === ContextResolution.OMIT) continue;

      const resName = getResolutionName(unit.resolution);
      let sectionContent = '';
      if (unit.resolution === ContextResolution.NAME) {
        sectionContent = `// File: ${unit.filePath || unit.title} (Present in repository)`;
      } else if (unit.resolution === ContextResolution.SIGNATURE || unit.resolution === ContextResolution.SKELETON) {
        sectionContent = `// [SKELETON] ${unit.title}\n${unit.content || ''}`;
      } else {
        sectionContent = unit.content || '';
      }

      sections.push({
        title: unit.title,
        filePath: unit.filePath,
        resolution: unit.resolution,
        content: sectionContent,
        unitId: unit.unitId,
      });

      lines.push(`\n<context_unit id="${unit.unitId}" resolution="${resName}" path="${unit.filePath || ''}">`);
      lines.push(sectionContent);
      lines.push('</context_unit>');
    }

    const promptText = lines.join('\n');
    // Approximate token count: ~4 chars per token
    const tokenEstimate = Math.ceil(promptText.length / 4);

    return {
      promptText,
      sections,
      metadata: {
        agent: this.id,
        unitsCount: units.length,
        includedCount: sections.length,
      },
      tokenEstimate,
    };
  }

  parseToolCalls(raw: unknown): ToolCallRecord[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => {
      const toolName = String(item.tool || item.name || item.toolName || 'unknown');
      const args = typeof item.input === 'object' && item.input !== null
        ? item.input
        : (typeof item.arguments === 'object' && item.arguments !== null ? item.arguments : {});
      return {
        timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
        toolName,
        arguments: args as Record<string, unknown>,
        result: item.result,
        error: item.error ? String(item.error) : undefined,
        durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
      };
    });
  }

  extractObservations(toolCalls: ToolCallRecord[]): AgentObservation {
    return extractGenericObservations(toolCalls);
  }
}

/**
 * Cursor specialized adapter
 */
export class CursorAdapter implements AgentAdapter {
  id = 'cursor';
  name = 'Cursor IDE Adapter';
  capabilities: AgentCapabilities = {
    supportsFileTree: true,
    supportsTerminal: true,
    supportsTestRunner: false,
    supportsLinter: true,
    customTools: ['read_file', 'edit_file', 'run_command'],
  };
  observabilityLevel: ObservabilityLevel = 'PARTIAL_AGENT_TRACE';

  formatContext(
    units: ContextUnitResolved[],
    options?: FormattingOptions
  ): FormattedContext {
    const sections: FormattedContext['sections'] = [];
    const lines: string[] = [];

    lines.push('### Relevant Repository Context\n');

    for (const unit of units) {
      if (unit.resolution === ContextResolution.OMIT) continue;

      const resName = getResolutionName(unit.resolution);
      const pathStr = unit.filePath ? ` (${unit.filePath})` : '';
      const sectionContent = unit.content || `[${resName}] ${unit.title}`;

      sections.push({
        title: unit.title,
        filePath: unit.filePath,
        resolution: unit.resolution,
        content: sectionContent,
        unitId: unit.unitId,
      });

      lines.push(`#### \`${unit.title}\`${pathStr} [${resName}]`);
      lines.push('```');
      lines.push(sectionContent);
      lines.push('```\n');
    }

    const promptText = lines.join('\n');
    const tokenEstimate = Math.ceil(promptText.length / 4);

    return {
      promptText,
      sections,
      metadata: {
        agent: this.id,
        unitsCount: units.length,
        includedCount: sections.length,
      },
      tokenEstimate,
    };
  }

  parseToolCalls(raw: unknown): ToolCallRecord[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => ({
      timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
      toolName: String(item.tool || item.name || 'unknown'),
      arguments: (item.args || item.arguments || {}) as Record<string, unknown>,
      result: item.result,
      error: item.error ? String(item.error) : undefined,
    }));
  }

  extractObservations(toolCalls: ToolCallRecord[]): AgentObservation {
    return extractGenericObservations(toolCalls);
  }
}

/**
 * Generic MCP Adapter for standards-compliant Model Context Protocol clients
 */
export class GenericMcpAdapter implements AgentAdapter {
  id = 'mcp-generic';
  name = 'Generic Model Context Protocol Adapter';
  capabilities: AgentCapabilities = {
    supportsFileTree: false,
    supportsTerminal: false,
    supportsTestRunner: false,
    supportsLinter: false,
    customTools: ['mcp_call_tool', 'mcp_read_resource'],
  };
  observabilityLevel: ObservabilityLevel = 'SIFTR_CALLS_ONLY';

  formatContext(
    units: ContextUnitResolved[],
    _options?: FormattingOptions
  ): FormattedContext {
    const sections: FormattedContext['sections'] = [];
    const lines: string[] = [];

    for (const unit of units) {
      if (unit.resolution === ContextResolution.OMIT) continue;
      const resName = getResolutionName(unit.resolution);
      const content = unit.content || `[${resName}] ${unit.title}`;
      sections.push({
        title: unit.title,
        filePath: unit.filePath,
        resolution: unit.resolution,
        content,
        unitId: unit.unitId,
      });

      lines.push(`--- ${unit.filePath || unit.title} [${resName}] ---`);
      lines.push(content);
    }

    const promptText = lines.join('\n\n');
    return {
      promptText,
      sections,
      metadata: {
        agent: this.id,
        unitsCount: units.length,
      },
      tokenEstimate: Math.ceil(promptText.length / 4),
    };
  }

  parseToolCalls(raw: unknown): ToolCallRecord[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => ({
      timestamp: Date.now(),
      toolName: String(item.name || item.tool || 'mcp_tool'),
      arguments: (item.arguments || {}) as Record<string, unknown>,
      result: item.result,
      error: item.error ? String(item.error) : undefined,
    }));
  }

  extractObservations(toolCalls: ToolCallRecord[]): AgentObservation {
    return extractGenericObservations(toolCalls);
  }
}
