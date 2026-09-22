/**
 * Phase 21 context providers.
 *
 * CONTROL: strong, non-Siftr deterministic repository map + lexical discovery.
 * TREATMENT: current production deterministic SiftrCode ContextEngine.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ContextEngine } from '../../engine/context_engine';
import { PRODUCTION_V2_POLICY_IDENTITY } from '../../engine/context_plan';
import { getRuntimeBuildProvenance } from '../../learning/episodes/runtime_provenance';

export const CONTROL_POLICY_ID = 'control-agent-native-lexical-v1';
export const SIFTRCODE_TREATMENT_POLICY_ID = PRODUCTION_V2_POLICY_IDENTITY.contextPolicyId;

export interface ExperimentContextRequest {
  workspaceDir: string;
  prompt: string;
  tokenBudget: number;
  candidateBudget: number;
  baseCommit: string;
  taskId: string;
  sessionId: string;
}

export interface ExperimentContextResult {
  contextPolicyId: string;
  implementationVersion: string;
  contextString: string;
  contextTokens: number;
  candidateCount: number;
  selectedUnitCount: number;
  generationLatencyMs: number;
  bundleSha256: string;
  runtimeGitSha: string | null;
  policyProvenance: Record<string, string | null>;
}

export interface ExperimentContextProvider {
  readonly arm: 'CONTROL' | 'SIFTRCODE';
  readonly contextPolicyId: string;
  getContext(request: ExperimentContextRequest): Promise<ExperimentContextResult>;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function listSourceFiles(root: string, maxFiles = 3000): string[] {
  const out: string[] = [];
  const skip = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__']);
  const walk = (dir: string) => {
    if (out.length >= maxFiles) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= maxFiles) return;
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(root);
  return out.sort();
}

function promptTerms(prompt: string): string[] {
  const stop = new Set(['the','and','for','with','from','that','this','into','when','then','your','should','would','could','file','code']);
  return Array.from(new Set(
    prompt.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g)?.filter((t) => !stop.has(t)) || []
  )).sort((a,b) => b.length - a.length).slice(0, 16);
}

export class AgentNativeLexicalControlProvider implements ExperimentContextProvider {
  public readonly arm = 'CONTROL' as const;
  public readonly contextPolicyId = CONTROL_POLICY_ID;
  public readonly implementationVersion = '1.0.0';

  public async getContext(request: ExperimentContextRequest): Promise<ExperimentContextResult> {
    const start = Date.now();
    const files = listSourceFiles(request.workspaceDir);
    const terms = promptTerms(request.prompt);
    const scored: Array<{ path: string; score: number; snippets: string[] }> = [];

    for (const rel of files) {
      let content = '';
      try {
        const stat = fs.statSync(path.join(request.workspaceDir, rel));
        if (stat.size > 512_000) continue;
        content = fs.readFileSync(path.join(request.workspaceDir, rel), 'utf8');
      } catch { continue; }
      const lowerPath = rel.toLowerCase();
      const lower = content.toLowerCase();
      let score = 0;
      const snippets: string[] = [];
      for (const term of terms) {
        if (lowerPath.includes(term)) score += 8;
        const idx = lower.indexOf(term);
        if (idx >= 0) {
          score += 2;
          const a = Math.max(0, idx - 180);
          const b = Math.min(content.length, idx + term.length + 320);
          snippets.push(content.slice(a, b).replace(/\s+/g, ' ').trim());
        }
      }
      if (score > 0) scored.push({ path: rel, score, snippets: snippets.slice(0, 2) });
    }

    scored.sort((a,b) => b.score - a.score || a.path.localeCompare(b.path));
    const candidates = scored.slice(0, request.candidateBudget);
    const tree = files.slice(0, Math.min(files.length, 500)).join('\n');
    let body = [
      'CONTROL CONTEXT — standard repository map + lexical discovery (no SiftrCode ranking).',
      '',
      'Repository files:',
      tree,
      '',
      'Prompt-linked lexical matches:',
    ].join('\n');

    let selected = 0;
    for (const c of candidates) {
      const addition = `\n\n### ${c.path}\n${c.snippets.join('\n...\n')}`;
      if (estimateTokens(body + addition) > request.tokenBudget) break;
      body += addition;
      selected++;
    }
    if (estimateTokens(body) > request.tokenBudget) {
      body = body.slice(0, Math.max(0, request.tokenBudget * 4));
    }

    const runtime = getRuntimeBuildProvenance();
    return {
      contextPolicyId: this.contextPolicyId,
      implementationVersion: this.implementationVersion,
      contextString: body,
      contextTokens: estimateTokens(body),
      candidateCount: candidates.length,
      selectedUnitCount: selected,
      generationLatencyMs: Date.now() - start,
      bundleSha256: crypto.createHash('sha256').update(body).digest('hex'),
      runtimeGitSha: runtime.siftrGitSha || null,
      policyProvenance: {
        strategy: 'repository-map-plus-lexical-search',
        rankerId: null,
        rankerVersion: null,
        featureSetVersion: null,
        candidateGeneratorVersion: 'control-lexical-v1',
        budgetPolicyVersion: 'control-budget-v1',
        materializerVersion: 'control-snippet-v1',
      },
    };
  }
}

export class DeterministicSiftrCodeTreatmentProvider implements ExperimentContextProvider {
  public readonly arm = 'SIFTRCODE' as const;
  public readonly contextPolicyId = SIFTRCODE_TREATMENT_POLICY_ID;
  public readonly implementationVersion = PRODUCTION_V2_POLICY_IDENTITY.rankerVersion;

  public async getContext(request: ExperimentContextRequest): Promise<ExperimentContextResult> {
    const start = Date.now();
    const result = await ContextEngine.optimizeWorkspace({
      workspaceDir: request.workspaceDir,
      prompt: request.prompt,
      taskId: request.taskId,
      sessionId: request.sessionId,
      tokenBudget: request.tokenBudget,
      candidateBudget: request.candidateBudget,
      contextPolicyIdentity: PRODUCTION_V2_POLICY_IDENTITY,
    });
    const plan = result.plan;
    const identity = plan.contextPolicyIdentity || plan.policyIdentity;
    if (!identity || identity.contextPolicyId !== PRODUCTION_V2_POLICY_IDENTITY.contextPolicyId) {
      throw new Error('FAIL_CLOSED_TREATMENT_PROVENANCE: Treatment did not use the production deterministic context policy.');
    }
    if (identity.rankerId !== PRODUCTION_V2_POLICY_IDENTITY.rankerId || identity.rankerStatus !== 'PRODUCTION') {
      throw new Error('FAIL_CLOSED_TREATMENT_PROVENANCE: Treatment ranker is not the production deterministic ranker.');
    }
    const body = result.contextString || result.formattedContext?.promptText || '';
    const runtime = getRuntimeBuildProvenance();
    return {
      contextPolicyId: identity.contextPolicyId,
      implementationVersion: identity.rankerVersion,
      contextString: body,
      contextTokens: plan.actualRenderedTokens ?? estimateTokens(body),
      candidateCount: plan.candidateUniverse?.length || 0,
      selectedUnitCount: plan.units.length,
      generationLatencyMs: plan.generationLatencyMs ?? (Date.now() - start),
      bundleSha256: crypto.createHash('sha256').update(body).digest('hex'),
      runtimeGitSha: runtime.siftrGitSha || null,
      policyProvenance: {
        contextPolicyId: identity.contextPolicyId,
        rankerId: identity.rankerId,
        rankerVersion: identity.rankerVersion,
        featureSetVersion: identity.featureSetVersion,
        candidateGeneratorVersion: identity.candidateGeneratorVersion,
        budgetPolicyVersion: identity.budgetPolicyVersion,
        materializerVersion: identity.materializerVersion,
      },
    };
  }
}
