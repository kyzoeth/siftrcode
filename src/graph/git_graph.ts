import { execSync } from 'child_process';
import { FeatureCutoff, isTimestampBeforeCutoff } from '../learning/point_in_time_features';

export interface GitCommitInfo {
  sha: string;
  timestampEpoch: number;
  timestampIso: string;
  message: string;
  files: string[];
}

export interface CoChangeRelationship {
  targetFile: string;
  score: number;
  sharedCommits: number;
}

export interface GitIntelligenceOptions {
  repoDir: string;
  historyWindow?: number; // default: 500 commits
  minSharedCommits?: number; // default: 3
  minRelationship?: number; // default: 0.15
}

export class GitGraphIntelligence {
  private repoDir: string;
  private historyWindow: number;
  private minSharedCommits: number;
  private minRelationship: number;

  constructor(options: GitIntelligenceOptions) {
    this.repoDir = options.repoDir;
    this.historyWindow = options.historyWindow ?? 500;
    this.minSharedCommits = options.minSharedCommits ?? 3;
    this.minRelationship = options.minRelationship ?? 0.15;
  }

  /**
   * Retrieves commits strictly before or at the FeatureCutoff point in time.
   * Architecture-level defense against future-information leakage.
   */
  public getCommitHistory(cutoff?: FeatureCutoff, limit?: number): GitCommitInfo[] {
    const max = limit ?? this.historyWindow;

    let untilArg = '';
    if (cutoff) {
      // Use ISO timestamp for git --until
      untilArg = ` --until="${cutoff.timestamp}"`;
    }

    let rawLog = '';
    try {
      rawLog = execSync(
        `git log -n ${max}${untilArg} --pretty=format:"COMMIT:%H|%at|%s" --name-only`,
        {
          cwd: this.repoDir,
          stdio: ['pipe', 'pipe', 'ignore'],
          encoding: 'utf-8',
          maxBuffer: 20 * 1024 * 1024,
        }
      );
    } catch {
      return [];
    }

    const commits: GitCommitInfo[] = [];
    const entries = rawLog.split('COMMIT:');

    for (const entry of entries) {
      const trimmed = entry.trim();
      if (!trimmed) continue;

      const lines = trimmed.split('\n');
      const header = lines[0];
      const [sha, epochStr, ...msgParts] = header.split('|');
      const epoch = parseInt(epochStr, 10);
      const iso = new Date(epoch * 1000).toISOString();
      const message = msgParts.join('|');

      // Architectural guard: strict cutoff check
      if (cutoff && !isTimestampBeforeCutoff(epoch, cutoff)) {
        continue;
      }

      const files = lines
        .slice(1)
        .map((f) => f.trim().replace(/\\/g, '/'))
        .filter((f) => f.length > 0);

      commits.push({
        sha,
        timestampEpoch: epoch,
        timestampIso: iso,
        message,
        files,
      });
    }

    return commits;
  }

  /**
   * Calculates directional co-change statistic:
   * coChange(A, B) = commits containing A and B / commits containing A
   */
  public calculateCoChange(fileA: string, fileB: string, cutoff?: FeatureCutoff): number {
    const normA = fileA.replace(/\\/g, '/').toLowerCase();
    const normB = fileB.replace(/\\/g, '/').toLowerCase();

    if (normA === normB) return 1.0;

    const commits = this.getCommitHistory(cutoff);
    let countA = 0;
    let countBoth = 0;

    for (const c of commits) {
      const hasA = c.files.some((f) => f.toLowerCase() === normA);
      const hasB = c.files.some((f) => f.toLowerCase() === normB);

      if (hasA) {
        countA++;
        if (hasB) countBoth++;
      }
    }

    if (countA === 0) return 0.0;
    return Number((countBoth / countA).toFixed(4));
  }

  /**
   * Computes the total change frequency of a file in the commit history up to cutoff.
   */
  public getFileChangeFrequency(file: string, cutoff?: FeatureCutoff): number {
    const norm = file.replace(/\\/g, '/').toLowerCase();
    const commits = this.getCommitHistory(cutoff);
    let count = 0;

    for (const c of commits) {
      if (c.files.some((f) => f.toLowerCase() === norm)) {
        count++;
      }
    }

    return count;
  }

  /**
   * Computes recent change frequency within a given number of days leading up to cutoff.
   */
  public getRecentChangeFrequency(file: string, daysWindow: number = 30, cutoff?: FeatureCutoff): number {
    const norm = file.replace(/\\/g, '/').toLowerCase();
    const commits = this.getCommitHistory(cutoff);

    const referenceTimeMs = cutoff ? new Date(cutoff.timestamp).getTime() : Date.now();
    const windowStartMs = referenceTimeMs - daysWindow * 24 * 60 * 60 * 1000;

    let count = 0;
    for (const c of commits) {
      const commitMs = c.timestampEpoch * 1000;
      if (commitMs >= windowStartMs && commitMs <= referenceTimeMs) {
        if (c.files.some((f) => f.toLowerCase() === norm)) {
          count++;
        }
      }
    }

    return count;
  }

  /**
   * Extracts all significant co-change relationships satisfying minSharedCommits and minRelationship.
   */
  public extractCoChangePairs(
    cutoff?: FeatureCutoff
  ): Array<{ fromPath: string; toPath: string; score: number; sharedCommits: number }> {
    const commits = this.getCommitHistory(cutoff);
    const fileCommitCounts = new Map<string, number>();
    const pairCommitCounts = new Map<string, number>();

    for (const c of commits) {
      const uniqueFiles = Array.from(new Set(c.files.map((f) => f.toLowerCase()))).sort();
      for (let i = 0; i < uniqueFiles.length; i++) {
        const fileI = uniqueFiles[i];
        fileCommitCounts.set(fileI, (fileCommitCounts.get(fileI) || 0) + 1);

        for (let j = 0; j < uniqueFiles.length; j++) {
          if (i === j) continue;
          const fileJ = uniqueFiles[j];
          const pairKey = `${fileI}|${fileJ}`;
          pairCommitCounts.set(pairKey, (pairCommitCounts.get(pairKey) || 0) + 1);
        }
      }
    }

    const results: Array<{ fromPath: string; toPath: string; score: number; sharedCommits: number }> = [];

    for (const [pairKey, sharedCount] of pairCommitCounts.entries()) {
      if (sharedCount < this.minSharedCommits) continue;

      const [fileA, fileB] = pairKey.split('|');
      const totalA = fileCommitCounts.get(fileA) || 1;
      const score = Number((sharedCount / totalA).toFixed(4));

      if (score >= this.minRelationship) {
        results.push({
          fromPath: fileA,
          toPath: fileB,
          score,
          sharedCommits: sharedCount,
        });
      }
    }

    return results;
  }
}
