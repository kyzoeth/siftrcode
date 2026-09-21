/**
 * SiftrCode V2 - Canonical MCP Schemas (Milestone Part XV)
 * Single source of truth for runtime validation and MCP JSON Schema tool declarations.
 */

import { z } from 'zod';

export const SiftrContextSchema = z.object({
  prompt: z.string().describe('The task prompt, bug description, or user instruction'),
  directory: z.string().optional().describe('Root directory of the workspace (defaults to current working directory)'),
  budgetProfile: z.enum(['balanced', 'aggressive', 'thorough']).optional().describe('Token budget profile (default: balanced)'),
  budgetTokens: z.number().int().positive().optional().describe('Explicit token budget override'),
  agentModel: z.string().optional().describe('Target model ID (e.g. claude-3-5-sonnet, gpt-4o)'),
  agentKind: z.string().optional().describe('Agent kind: claude_code, cursor, or generic_mcp'),
  dirtyPaths: z.array(z.string()).optional().describe('List of dirty or modified files in the working directory'),
  taskId: z.string().optional().describe('Optional persistent task ID to bind this optimization plan to'),
  sessionId: z.string().optional().describe('Optional active SiftrSession ID (auto-created if omitted)'),
});

export type SiftrContextInput = z.infer<typeof SiftrContextSchema>;

export const SiftrExpandSchema = z.object({
  directory: z.string().optional().describe('Root directory of the workspace (defaults to current working directory)'),
  filePath: z.string().optional().describe('Target file path to read at full resolution'),
  contextUnitId: z.string().optional().describe('Target ContextUnit ID from a previous ContextPlan to progressively disclose'),
  targetResolution: z.enum(['body', 'full']).optional().default('body').describe('Target resolution: "body" (implementation only) or "full" (entire file)'),
  taskId: z.string().optional().describe('Task ID to bind this expansion to'),
  sessionId: z.string().optional().describe('Session ID to bind this expansion to'),
  planId: z.string().optional().describe('ContextPlan ID to bind this expansion to'),
});

export type SiftrExpandInput = z.infer<typeof SiftrExpandSchema>;

export const OutcomeEvidenceInputSchema = z.object({
  buildPassed: z.boolean().optional(),
  publicTestsPassed: z.boolean().optional(),
  hiddenTestsPassed: z.boolean().optional(),
  regressionTestsPassed: z.boolean().optional(),
  staticChecksPassed: z.boolean().optional(),
  securityChecksPassed: z.boolean().optional(),
  behavioralOraclePassed: z.boolean().optional(),
  userAccepted: z.boolean().optional(),
  agentReportedSuccess: z.boolean().optional(),
  humanReview: z.boolean().optional(),
  actualProviderInputTokens: z.number().int().nonnegative().optional(),
  actualProviderOutputTokens: z.number().int().nonnegative().optional(),
  costUSD: z.number().nonnegative().optional(),
  wallTimeMs: z.number().nonnegative().optional(),
});

export const SiftrOutcomeSchema = z.object({
  planId: z.string().optional().describe('The ContextPlan ID that produced the context'),
  sessionId: z.string().optional().describe('The SiftrSession ID for the task'),
  taskId: z.string().optional().describe('The TaskContext ID for the task'),
  directory: z.string().optional().describe('Root directory of the workspace (defaults to current working directory)'),
  evidence: OutcomeEvidenceInputSchema.describe('Evidence vector collected after agent task execution'),
});

export type SiftrOutcomeInput = z.infer<typeof SiftrOutcomeSchema>;

export const SiftrSessionSchema = z.object({
  action: z.enum(['start', 'status', 'end']).describe('Session lifecycle action to perform'),
  sessionId: z.string().optional().describe('Session ID to query or end (required for status and end)'),
  taskId: z.string().optional().describe('Task ID to associate with the new session'),
  directory: z.string().optional().describe('Root directory of the workspace (defaults to current working directory)'),
  agentEnvironmentId: z.string().optional().describe('Agent environment identifier'),
});

export type SiftrSessionInput = z.infer<typeof SiftrSessionSchema>;

export const SiftrRankSchema = z.object({
  prompt: z.string().describe('The task prompt, bug description, or user instruction'),
  directory: z.string().optional().describe('Root directory of the workspace (defaults to current working directory)'),
  limit: z.number().int().positive().optional().default(15).describe('Maximum number of ranked candidates to return'),
  agentModel: z.string().optional().describe('Target model ID for cost estimation'),
});

export type SiftrRankInput = z.infer<typeof SiftrRankSchema>;

/**
 * Converts a ZodObject schema into JSON Schema representation for MCP tool input schemas.
 */
export function zodToJsonSchema(schema: z.ZodObject<any>): {
  type: 'object';
  properties: Record<string, any>;
  required?: string[];
} {
  const shape = schema.shape;
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    const isOptional = (field as any).isOptional?.() || (field as any) instanceof z.ZodDefault;
    if (!isOptional) {
      required.push(key);
    }

    properties[key] = zodFieldToJsonSchema(field as z.ZodTypeAny);
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function zodFieldToJsonSchema(field: z.ZodTypeAny): Record<string, any> {
  let curr = field;
  const description = curr.description;

  // Unwrap optional, default, nullable
  while (
    curr instanceof z.ZodOptional ||
    curr instanceof z.ZodNullable ||
    curr instanceof z.ZodDefault
  ) {
    if (curr instanceof z.ZodDefault) {
      curr = (curr as any)._def.innerType;
    } else {
      curr = (curr as any).unwrap();
    }
  }

  let schema: Record<string, any> = {};

  if (curr instanceof z.ZodString) {
    schema.type = 'string';
  } else if (curr instanceof z.ZodNumber) {
    schema.type = 'number';
  } else if (curr instanceof z.ZodBoolean) {
    schema.type = 'boolean';
  } else if (curr instanceof z.ZodEnum) {
    schema.type = 'string';
    schema.enum = (curr as any).options;
  } else if (curr instanceof z.ZodArray) {
    schema.type = 'array';
    schema.items = zodFieldToJsonSchema((curr as any).element);
  } else if (curr instanceof z.ZodObject) {
    schema = zodToJsonSchema(curr);
  } else {
    schema.type = 'string';
  }

  if (description) {
    schema.description = description;
  }

  return schema;
}
