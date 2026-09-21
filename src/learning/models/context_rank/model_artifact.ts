/**
 * SiftrCode V3 - Model Artifact Schema & Checksum Verification (Phase V3.1F)
 *
 * Invariants:
 * 1. Model artifacts are immutable and cryptographically signed.
 * 2. Every artifact retains complete training provenance, git SHA, and dataset hashes.
 * 3. Artifact checksum verification is mandatory prior to instantiation.
 */

import * as crypto from 'crypto';

export interface ModelHyperparameters {
  modelFamily: 'pairwise_gbdt' | 'linear_margin_pairwise';
  learningRate: number;
  maxIterations: number;
  maxDepth?: number;
  regularizationL2?: number;
  subsampleRatio?: number;
  featureSubsetRatio?: number;
  includeJev: boolean;
  randomSeed: number;
  [key: string]: unknown;
}

export interface ModelEvaluationSummary {
  ndcg5: number;
  ndcg10: number;
  ndcg20: number;
  recall5: number;
  recall10: number;
  mrr: number;
  loss?: number;
}

export interface ModelArtifactV3 {
  schemaVersion: 'siftrcode-model-artifact-v3';
  modelId: string;
  modelType: 'pairwise_gbdt' | 'linear_margin_pairwise';
  status: 'RESEARCH' | 'SHADOW' | 'CANDIDATE' | 'PROMOTED' | 'RETIRED';
  trainingCodeGitSha: string;
  datasetVersion: string;
  featureSetVersion: string;
  trainSplitHash: string;
  validationSplitHash: string;
  hyperparameters: ModelHyperparameters;
  randomSeed: number;
  libraryVersions: {
    node: string;
    typescript: string;
    siftrcode: string;
  };
  trainingTimestamp: string;
  trainingMetrics: ModelEvaluationSummary;
  validationMetrics: ModelEvaluationSummary;
  rightsProvenanceSummary: {
    rightsPermitted: boolean;
    sourcesUsed: string[];
    rawSourceExcluded: boolean;
  };
  modelPayload: Record<string, unknown>;
  artifactChecksum: string;
}

export class ModelArtifactVerifier {
  /**
   * Computes the canonical SHA-256 checksum of an artifact payload.
   */
  public static computeChecksum(artifact: Omit<ModelArtifactV3, 'artifactChecksum'>): string {
    const sortObject = (obj: any): any => {
      if (obj === null || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(sortObject);
      const sorted: Record<string, any> = {};
      for (const k of Object.keys(obj).sort()) {
        sorted[k] = sortObject(obj[k]);
      }
      return sorted;
    };
    const canonicalStr = JSON.stringify(sortObject(artifact));
    return crypto.createHash('sha256').update(canonicalStr).digest('hex');
  }

  /**
   * Verifies an artifact's checksum and mandatory metadata fields.
   */
  public static verifyArtifact(artifact: ModelArtifactV3): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (artifact.schemaVersion !== 'siftrcode-model-artifact-v3') {
      errors.push(`Invalid schemaVersion: ${artifact.schemaVersion}`);
    }
    if (!artifact.modelId || !artifact.modelType) {
      errors.push('Missing modelId or modelType');
    }
    if (!artifact.trainingCodeGitSha || artifact.trainingCodeGitSha.length !== 40) {
      errors.push(`Invalid trainingCodeGitSha: ${artifact.trainingCodeGitSha}`);
    }
    if (!artifact.featureSetVersion) {
      errors.push('Missing featureSetVersion');
    }

    const { artifactChecksum, ...unsigned } = artifact;
    const computed = ModelArtifactVerifier.computeChecksum(unsigned);
    if (artifactChecksum !== computed) {
      errors.push(`Checksum mismatch: expected ${artifactChecksum}, computed ${computed}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
