import * as http from 'http';
import * as https from 'https';
import { ContextUnit } from '../context/context_unit';
import { TaskContext } from '../context/task_context';
import { TaskEvidenceKind, StackTraceEvidence, TestFailureEvidence } from '../context/task_evidence';
import { JudgmentProvider, JudgmentGraphContext, JudgmentResult } from './judgment_provider';
import { EnforcedEgressGateway } from '../security/egress_policy';
import { DataRights } from '../rights/data_rights';
import { TrustLevel } from '../security/trust';

export interface JevJudgmentProviderOptions {
  apiKey?: string | null;
  endpoint?: string;
  timeoutMs?: number;
  egressGateway?: EnforcedEgressGateway;
  dataRights?: DataRights;
  trustLevel?: TrustLevel;
  budgetExhausted?: boolean;
  maxCalls?: number;
}

export class JevJudgmentProvider implements JudgmentProvider {
  private apiKey: string | null;
  private endpoint: string;
  private timeoutMs: number;
  private egressGateway?: EnforcedEgressGateway;
  private dataRights?: DataRights;
  private trustLevel?: TrustLevel;
  private budgetExhausted: boolean;
  private maxCalls: number;
  private callCount = 0;

  constructor(options: JevJudgmentProviderOptions = {}) {
    this.apiKey = options.apiKey !== undefined ? options.apiKey : (process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY || null);
    this.endpoint = options.endpoint || 'https://api.typesafe.ai/v2/judge';
    this.timeoutMs = options.timeoutMs ?? 2000;
    this.egressGateway = options.egressGateway;
    this.dataRights = options.dataRights;
    this.trustLevel = options.trustLevel;
    this.budgetExhausted = options.budgetExhausted ?? false;
    this.maxCalls = options.maxCalls ?? 1000;
  }

  /**
   * Evaluates a candidate ContextUnit. Emits independent signals (Section 46):
   * semanticRelevance, implementationNeeded, likelyEditTarget, likelyRootCause, confidence.
   * Fully resilient to missing key, timeouts, HTTP errors, malformed responses, partial responses,
   * budget exhaustion, and egress policy blocks (Section 47).
   */
  public async judge(
    task: TaskContext,
    candidate: ContextUnit,
    graphContext?: JudgmentGraphContext
  ): Promise<JudgmentResult> {
    const startTime = Date.now();

    // 1. Resilience Gate: No API key
    if (!this.apiKey) {
      return this.localHeuristicJudge(task, candidate, graphContext, startTime, 'no_api_key');
    }

    // 2. Resilience Gate: Budget exhausted or max calls reached
    if (this.budgetExhausted || this.callCount >= this.maxCalls) {
      return this.localHeuristicJudge(task, candidate, graphContext, startTime, 'budget_exhausted');
    }

    // 3. Resilience Gate: Enforced Egress Gateway (DataRights, TrustLevel, SecretDetector)
    if (this.egressGateway && this.dataRights) {
      try {
        return await this.egressGateway
          .executeWithEgressEnforcement({
            providerName: 'typesafe-jev',
            units: [candidate],
            contents: [task.primaryPrompt + ' ' + (candidate.path || '')],
            rights: this.dataRights,
            execute: (sanitized) => this.callRemoteApi(task, candidate, graphContext, startTime),
          })
          .then((r) => r.result);
      } catch (err: any) {
        return this.localHeuristicJudge(
          task,
          candidate,
          graphContext,
          startTime,
          `egress_blocked: ${err.message}`
        );
      }
    }

    this.callCount++;

    // 4. Remote HTTP/HTTPS Call with timeout & error resilience
    try {
      return await this.callRemoteApi(task, candidate, graphContext, startTime);
    } catch (err: any) {
      const fallbackReason = err.message || 'remote_call_error';
      return this.localHeuristicJudge(task, candidate, graphContext, startTime, fallbackReason);
    }
  }

  /**
   * Batch judgment over candidates.
   */
  public async judgeBatch(
    task: TaskContext,
    candidates: Array<{ candidate: ContextUnit; graphContext?: JudgmentGraphContext }>
  ): Promise<JudgmentResult[]> {
    return Promise.all(candidates.map((c) => this.judge(task, c.candidate, c.graphContext)));
  }

  private async callRemoteApi(
    task: TaskContext,
    candidate: ContextUnit,
    graphContext: JudgmentGraphContext | undefined,
    startTime: number
  ): Promise<JudgmentResult> {
    const payload = JSON.stringify({
      taskId: task.taskId,
      primaryPrompt: task.primaryPrompt,
      candidate: {
        id: candidate.id,
        kind: candidate.kind,
        path: candidate.path,
        title: candidate.title,
        metadata: candidate.metadata,
      },
      graphContext: graphContext || {},
    });

    const url = new URL(this.endpoint);
    const isHttp = url.protocol === 'http:';
    const requestFn = isHttp ? http.request : https.request;

    return new Promise((resolve, reject) => {
      const req = requestFn(
        {
          hostname: url.hostname,
          port: url.port ? parseInt(url.port, 10) : (isHttp ? 80 : 443),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            const latencyMs = Date.now() - startTime;

            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(body);

                // Resilience Gate: Partial response handling (Section 47)
                // If response is valid JSON but missing some fields, robustly fill in using local heuristics
                const local = this.localHeuristicJudge(task, candidate, graphContext, startTime);

                const semanticRelevance =
                  typeof parsed.semanticRelevance === 'number'
                    ? Math.max(0, Math.min(1, parsed.semanticRelevance))
                    : typeof parsed.score === 'number'
                    ? Math.max(0, Math.min(1, parsed.score / 10))
                    : local.semanticRelevance;

                const implementationNeeded =
                  typeof parsed.implementationNeeded === 'boolean'
                    ? parsed.implementationNeeded
                    : local.implementationNeeded;

                const likelyEditTarget =
                  typeof parsed.likelyEditTarget === 'boolean'
                    ? parsed.likelyEditTarget
                    : local.likelyEditTarget;

                const likelyRootCause =
                  typeof parsed.likelyRootCause === 'boolean'
                    ? parsed.likelyRootCause
                    : local.likelyRootCause;

                const confidence =
                  typeof parsed.confidence === 'number'
                    ? Math.max(0, Math.min(1, parsed.confidence))
                    : 0.95;

                resolve({
                  candidateUnitId: candidate.id,
                  semanticRelevance: Number(semanticRelevance.toFixed(4)),
                  implementationNeeded,
                  likelyEditTarget,
                  likelyRootCause,
                  confidence: Number(confidence.toFixed(4)),
                  provider: 'typesafe-jev',
                  latencyMs,
                  rationale: parsed.rationale || 'Evaluated via Typesafe JEV API',
                  rawSignals: parsed,
                });
              } catch (parseErr: any) {
                // Resilience Gate: Malformed JSON response
                reject(new Error(`malformed_response: ${parseErr.message}`));
              }
            } else {
              // Resilience Gate: HTTP error response
              reject(new Error(`http_error_${res.statusCode}`));
            }
          });
        }
      );

      req.on('error', (err) => reject(new Error(`network_error: ${err.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });

      req.write(payload);
      req.end();
    });
  }

  /**
   * Deterministic, high-accuracy local heuristic intelligence fallback (Section 47).
   */
  public localHeuristicJudge(
    task: TaskContext,
    candidate: ContextUnit,
    graphContext: JudgmentGraphContext | undefined,
    startTime: number = Date.now(),
    fallbackReason?: string
  ): JudgmentResult {
    const latencyMs = Date.now() - startTime;
    const promptLower = task.primaryPrompt.toLowerCase();
    const pathLower = (candidate.path || '').toLowerCase();
    const titleLower = (candidate.title || '').toLowerCase();

    const promptKeywords = promptLower.split(/\W+/).filter((k) => k.length > 2);

    let matchCount = 0;
    for (const kw of promptKeywords) {
      if (pathLower.includes(kw)) matchCount += 2;
      if (titleLower.includes(kw)) matchCount += 3;
    }

    // Graph proximity signal
    let graphBonus = 0;
    if (graphContext?.graphDistance !== undefined && graphContext.graphDistance !== null) {
      if (graphContext.graphDistance === 1) graphBonus = 0.3;
      else if (graphContext.graphDistance === 2) graphBonus = 0.15;
    }

    // Check evidence (stack trace / test failures)
    let inEvidence = false;
    for (const ev of task.evidence || []) {
      if (ev.kind === TaskEvidenceKind.STACK_TRACE) {
        const trace = ev as StackTraceEvidence;
        for (const frame of trace.frames || []) {
          if (candidate.path && frame.file.includes(candidate.path)) {
            inEvidence = true;
          }
        }
      } else if (ev.kind === TaskEvidenceKind.TEST_FAILURE) {
        const failure = ev as TestFailureEvidence;
        if (candidate.path && failure.testFilePath?.includes(candidate.path)) {
          inEvidence = true;
        }
      }
    }

    const rawRelevance = Math.min(1.0, (matchCount * 0.2) + graphBonus + (inEvidence ? 0.4 : 0));
    const semanticRelevance = Number(rawRelevance.toFixed(4));

    const likelyEditTarget = inEvidence || matchCount >= 4 || (matchCount >= 2 && graphContext?.graphDistance === 1);
    const likelyRootCause = inEvidence || (matchCount >= 3 && graphContext?.isDirectDependency === true);
    const implementationNeeded = semanticRelevance >= 0.25;

    return {
      candidateUnitId: candidate.id,
      semanticRelevance,
      implementationNeeded,
      likelyEditTarget,
      likelyRootCause,
      confidence: fallbackReason ? 0.82 : 0.9,
      provider: 'local-heuristic',
      latencyMs,
      fallbackReason,
      rationale: fallbackReason
        ? `Fallback to local intelligence (${fallbackReason})`
        : 'Evaluated via deterministic local heuristic',
    };
  }
}
