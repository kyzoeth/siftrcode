/**
 * SiftrCode V2 - Canonical MCP Schemas (Milestone Part XV)
 * Single source of truth for runtime validation and MCP JSON Schema tool declarations.
 */

import { z } from 'zod';

export const SiftrSkeletonSchema = z.object({
  filePath: z.string().optional().describe('Relative or absolute path to the source file on disk'),
  content: z.string().optional().describe('Optional: Direct in-memory source code content to skeletonize (bypasses reading from disk)'),
});

export type SiftrSkeletonInput = z.infer<typeof SiftrSkeletonSchema>;

export const SiftrBatchSkeletonSchema = z.object({
  filePaths: z.array(z.string()).describe('Array of relative or absolute file paths to skeletonize'),
});

export type SiftrBatchSkeletonInput = z.infer<typeof SiftrBatchSkeletonSchema>;

export const SiftrPackSchema = z.object({
  focus: z.string().optional().describe('The task description or focus area (e.g. "checkout subscription webhook race condition")'),
  directory: z.string().optional().describe('Directory path to scan (defaults to current working directory)'),
  output: z.string().optional().describe('Output filename for the compiled context pack (defaults to siftr_context.md)'),
  includeContent: z.boolean().optional().default(true).describe('Whether to return the compiled context pack directly in the response text (defaults to true)'),
});

export type SiftrPackInput = z.infer<typeof SiftrPackSchema>;

export const SiftrAuditSchema = z.object({
  directory: z.string().optional().describe('Directory path to audit'),
  code: z.string().optional().describe('Code snippet to audit'),
  language: z.string().optional().describe('Language of snippet'),
});

export type SiftrAuditInput = z.infer<typeof SiftrAuditSchema>;

export const SiftrContextSchema = z.object({
  prompt: z.string().describe('Developer task description, issue summary, or prompt'),
  directory: z.string().optional().describe('Target workspace directory path (defaults to current working directory)'),
  agentModel: z.string().optional().describe('Target LLM agent model name (e.g. claude-3-5-sonnet, gpt-4o, cursor)'),
  agentKind: z.enum(['claude_code', 'cursor', 'generic_mcp']).optional().describe('Target agent environment adapter (defaults to claude_code)'),
  budgetProfile: z.enum(['LEAN', 'BALANCED', 'THOROUGH', 'balanced', 'aggressive', 'thorough']).optional().describe('Budget optimization profile (defaults to BALANCED)'),
  tokenBudget: z.number().int().positive().optional().describe('Explicit maximum token budget'),
  maxCostUSD: z.number().positive().optional().describe('Explicit maximum economic cost ceiling in USD'),
  includeContext: z.boolean().optional().default(true).describe('Whether to return the compiled context text directly in the response (defaults to true)'),
  includePlan: z.boolean().optional().default(true).describe('Whether to include the complete ContextPlan metadata object (defaults to true)'),
  dirtyPaths: z.array(z.string()).optional().describe('List of dirty or modified files in the working directory'),
  taskId: z.string().optional().describe('Optional persistent task ID to bind this optimization plan to'),
  sessionId: z.string().optional().describe('Optional active SiftrSession ID (auto-created if omitted)'),
});

export type SiftrContextInput = z.infer<typeof SiftrContextSchema>;

export const SiftrOptimizeSchema = SiftrContextSchema;
export type SiftrOptimizeInput = z.infer<typeof SiftrOptimizeSchema>;

export const SiftrRankSchema = z.object({
  prompt: z.string().describe('Developer task description or issue prompt'),
  directory: z.string().optional().describe('Target workspace directory path (defaults to current working directory)'),
  limit: z.number().int().positive().optional().default(20).describe('Maximum number of ranked candidates to return (defaults to 20)'),
  agentModel: z.string().optional().describe('Target model ID for cost estimation'),
});

export type SiftrRankInput = z.infer<typeof SiftrRankSchema>;

export const OutcomeEvidenceInputSchema = z.object({
  buildPassed: z.boolean().optional(),
  publicTestsPassed: z.boolean().optional(),
  testsPassed: z.boolean().optional(),
  hiddenTestsPassed: z.boolean().optional(),
  regressionTestsPassed: z.boolean().optional(),
  staticChecksPassed: z.boolean().optional(),
  securityChecksPassed: z.boolean().optional(),
  behavioralOraclePassed: z.boolean().optional(),
  userAccepted: z.boolean().optional(),
  agentReportedSuccess: z.boolean().optional(),
  agentClaimedSuccess: z.boolean().optional(),
  humanReview: z.boolean().optional(),
  actualProviderInputTokens: z.number().int().nonnegative().optional(),
  actualProviderOutputTokens: z.number().int().nonnegative().optional(),
  costUSD: z.number().nonnegative().optional(),
  wallTimeMs: z.number().nonnegative().optional(),
});

export const SiftrOutcomeSchema = z.object({
  taskId: z.string().optional().describe('Task identifier returned by siftr_context'),
  planId: z.string().optional().describe('ContextPlan identifier returned by siftr_context'),
  sessionId: z.string().optional().describe('Session identifier linking task and context plan'),
  directory: z.string().optional().describe('Target workspace directory path (defaults to current working directory)'),
  evidence: OutcomeEvidenceInputSchema.optional().describe('Evidence vector collected after agent task execution'),
  // Direct flat fields matching MCP tool advertising
  finalStatus: z.string().optional().describe('Final execution status (e.g. SUCCESS, FAILURE)'),
  userAccepted: z.boolean().optional().describe('Whether the user accepted the result'),
  editsCount: z.number().int().nonnegative().optional().describe('Number of edits made during task'),
  buildPassed: z.boolean().optional().describe('Whether build succeeded'),
  publicTestsPassed: z.boolean().optional().describe('Whether public tests passed'),
  hiddenTestsPassed: z.boolean().optional().describe('Whether hidden tests passed'),
  testsPassed: z.boolean().optional().describe('Whether task-specific test suite passed'),
  regressionTestsPassed: z.boolean().optional().describe('Whether existing test suite / regression checks passed'),
  staticChecksPassed: z.boolean().optional().describe('Whether type-checking and linter checks passed'),
  securityChecksPassed: z.boolean().optional().describe('Whether security scanners passed'),
  behavioralOraclePassed: z.boolean().optional().describe('Whether behavioral test oracle passed'),
  agentClaimedSuccess: z.boolean().optional().describe('Whether the coding agent self-reported completion'),
  humanReview: z.any().optional().describe('Human review outcome or boolean approval'),
  actualProviderInputTokens: z.number().int().nonnegative().optional().describe('Post-turn input token consumption reported by LLM provider'),
  actualProviderOutputTokens: z.number().int().nonnegative().optional().describe('Post-turn output token consumption reported by LLM provider'),
  costUSD: z.number().nonnegative().optional().describe('Actual monetary cost incurred in USD'),
  wallTimeMs: z.number().nonnegative().optional().describe('Total task execution wall time in milliseconds'),
  notes: z.string().optional().describe('Optional execution notes or failure rationale'),
}).passthrough();

export type SiftrOutcomeInput = z.infer<typeof SiftrOutcomeSchema>;

export const SiftrExpandSchema = z.object({
  filePath: z.string().optional().describe('Relative or absolute file path to expand'),
  contextUnitId: z.string().optional().describe('Context unit ID to expand'),
  targetResolution: z.enum(['body', 'full', 'BODY', 'FULL']).optional().default('body').describe('Target expansion resolution: "body" (implementation only) or "full" (entire file)'),
  taskId: z.string().optional().describe('Active task identifier'),
  sessionId: z.string().optional().describe('Active session identifier'),
  planId: z.string().optional().describe('ContextPlan ID to bind this expansion to'),
  directory: z.string().optional().describe('Target workspace directory path (defaults to current working directory)'),
});

export type SiftrExpandInput = z.infer<typeof SiftrExpandSchema>;

export const SiftrSessionSchema = z.object({
  action: z.enum(['start', 'status', 'end']).optional().default('status').describe('Session lifecycle action (defaults to status)'),
  taskId: z.string().optional().describe('Task ID to associate with the session'),
  sessionId: z.string().optional().describe('Session ID to query or end'),
  agentModel: z.string().optional().describe('Agent model name'),
  directory: z.string().optional().describe('Target workspace directory path (defaults to current working directory)'),
  agentEnvironmentId: z.string().optional().describe('Agent environment identifier'),
});

export type SiftrSessionInput = z.infer<typeof SiftrSessionSchema>;

export const MCP_TOOL_SCHEMAS = {
  siftr_skeleton: SiftrSkeletonSchema,
  siftr_batch_skeleton: SiftrBatchSkeletonSchema,
  siftr_pack: SiftrPackSchema,
  siftr_audit: SiftrAuditSchema,
  siftr_context: SiftrContextSchema,
  siftr_optimize: SiftrOptimizeSchema,
  siftr_rank: SiftrRankSchema,
  siftr_outcome: SiftrOutcomeSchema,
  siftr_expand: SiftrExpandSchema,
  siftr_session: SiftrSessionSchema,
} as const;

export type McpToolName = keyof typeof MCP_TOOL_SCHEMAS;

/**
 * Validates raw tool call arguments against the canonical Zod schema.
 */
export function validateToolCall<T extends McpToolName>(
  toolName: T,
  rawArgs: unknown
): { success: true; data: z.infer<(typeof MCP_TOOL_SCHEMAS)[T]> } | { success: false; error: string } {
  const schema = MCP_TOOL_SCHEMAS[toolName] as z.ZodTypeAny;
  if (!schema) {
    return { success: false, error: `Unknown tool name: ${String(toolName)}` };
  }
  const parseResult = schema.safeParse(rawArgs || {});
  if (!parseResult.success) {
    const errorDetails = (parseResult.error as z.ZodError).issues
      .map((e: z.ZodIssue) => `${e.path.join('.') || 'root'}: ${e.message}`)
      .join(', ');
    return { success: false, error: `Invalid arguments for tool ${toolName}: ${errorDetails}` };
  }
  return { success: true, data: parseResult.data as any };
}

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
    const isOptional =
      (field as any).isOptional?.() ||
      (field as any) instanceof z.ZodDefault ||
      (field as any)._def?.typeName === 'ZodOptional' ||
      (field as any)._def?.typeName === 'ZodDefault';

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
