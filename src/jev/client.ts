import * as https from 'https';
import * as http from 'http';

/**
 * @deprecated V1 JevDecisionRequest. In SiftrCode V2, use JudgmentProvider and JudgmentGraphContext instead.
 */
export interface JevDecisionRequest {
  state: string; // The file path, symbols, imports, and task description
  questions: {
    classification?: {
      type: 'choice';
      options: ['RootCandidate', 'TypeDependencyOnly', 'DeadWeight'];
    };
    relevance_score?: {
      type: 'score';
      scale: 10;
    };
    is_critical_path?: {
      type: 'noul';
    };
  };
}

/**
 * @deprecated V1 JevDecisionResponse. In SiftrCode V2, use JudgmentResult with independent signals
 * (semanticRelevance, implementationNeeded, likelyEditTarget, likelyRootCause, confidence) instead.
 */
export interface JevDecisionResponse {
  classification: 'RootCandidate' | 'TypeDependencyOnly' | 'DeadWeight';
  score: number;
  is_critical_path: boolean;
  confidence: number;
  source: 'typesafe-api' | 'local-heuristic';
}

/**
 * @deprecated V1 JevClient. In SiftrCode V2, use JevJudgmentProvider implementing JudgmentProvider.
 */
export class JevClient {
  private apiKey: string | null;
  private endpoint: string;

  constructor(apiKey?: string, endpoint: string = 'https://api.typesafe.ai/v1/decisions') {
    // Environment-key inheritance is strictly disabled to prevent live System One credential usage
    // and prevent legacy callers (like siftr_pack) from bypassing SiftrCode V2 data rights.
    this.apiKey = apiKey || null;
    this.endpoint = endpoint;
  }

  public getApiKey(): string | null {
    return this.apiKey;
  }

  /**
   * @deprecated Evaluates file relevance using V1 classification. In SiftrCode V2, use JevJudgmentProvider.judge().
   */
  public async evaluate(
    filePath: string,
    symbols: string[],
    imports: string[],
    taskPrompt: string
  ): Promise<JevDecisionResponse> {
    if (this.apiKey) {
      try {
        return await this.callJevApi(filePath, symbols, imports, taskPrompt);
      } catch (err) {
        // Fall back to heuristic on network or API failure
        return this.localHeuristic(filePath, symbols, imports, taskPrompt);
      }
    }

    return this.localHeuristic(filePath, symbols, imports, taskPrompt);
  }

  private async callJevApi(
    filePath: string,
    symbols: string[],
    imports: string[],
    taskPrompt: string
  ): Promise<JevDecisionResponse> {
    const payload = {
      state: JSON.stringify({
        task: taskPrompt,
        file: filePath,
        symbols: symbols.slice(0, 30),
        imports: imports.slice(0, 20)
      }),
      questions: [
        {
          id: 'classification',
          primitive: 'choice',
          options: ['RootCandidate', 'TypeDependencyOnly', 'DeadWeight']
        },
        {
          id: 'score',
          primitive: 'score',
          levels: 10
        },
        {
          id: 'critical_path',
          primitive: 'noul'
        }
      ]
    };

    const data = JSON.stringify(payload);
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
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Length': Buffer.byteLength(data)
          },
          timeout: 2000
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(body);
                resolve({
                  classification: parsed.decisions?.classification || 'TypeDependencyOnly',
                  score: parsed.decisions?.score || 5,
                  is_critical_path: parsed.decisions?.critical_path ?? true,
                  confidence: parsed.confidence || 0.95,
                  source: 'typesafe-api'
                });
              } catch (e) {
                reject(e);
              }
            } else {
              reject(new Error(`Jev API returned HTTP ${res.statusCode}: ${body}`));
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Jev API timeout'));
      });

      req.write(data);
      req.end();
    });
  }

  /**
   * Fast, deterministic local heuristic classifier when running offline.
   */
  private localHeuristic(
    filePath: string,
    symbols: string[],
    imports: string[],
    taskPrompt: string
  ): JevDecisionResponse {
    const lowerPrompt = taskPrompt.toLowerCase();
    const lowerPath = filePath.toLowerCase();
    const promptKeywords = lowerPrompt.split(/\W+/).filter((k) => k.length > 2);

    let matchCount = 0;
    for (const kw of promptKeywords) {
      if (lowerPath.includes(kw)) matchCount += 3;
      for (const sym of symbols) {
        if (sym.toLowerCase().includes(kw)) matchCount += 2;
      }
      for (const imp of imports) {
        if (imp.toLowerCase().includes(kw)) matchCount += 1;
      }
    }

    if (matchCount >= 4) {
      return {
        classification: 'RootCandidate',
        score: Math.min(10, 7 + matchCount),
        is_critical_path: true,
        confidence: 0.9,
        source: 'local-heuristic'
      };
    } else if (matchCount >= 1 || lowerPath.includes('types') || lowerPath.includes('models') || lowerPath.includes('schema') || lowerPath.includes('interface')) {
      return {
        classification: 'TypeDependencyOnly',
        score: Math.max(3, Math.min(7, 3 + matchCount)),
        is_critical_path: false,
        confidence: 0.85,
        source: 'local-heuristic'
      };
    } else {
      return {
        classification: 'DeadWeight',
        score: 1,
        is_critical_path: false,
        confidence: 0.8,
        source: 'local-heuristic'
      };
    }
  }
}
