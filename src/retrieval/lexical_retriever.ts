import { ContextUnit, isCodeSymbolUnit } from '../context/context_unit';
import { TaskContext } from '../context/task_context';

export interface LexicalSearchResult {
  unitId: string;
  score: number;
  matchedTerms: string[];
}

export class LexicalRetriever {
  /**
   * Performs lexical term-frequency retrieval against ContextUnits.
   */
  public search(task: TaskContext, units: ContextUnit[], limit: number = 50): LexicalSearchResult[] {
    const queryTokens = this.tokenize(
      `${task.primaryPrompt} ${task.evidence.map((e) => ('message' in e ? e.message : '')).join(' ')}`
    );

    if (queryTokens.length === 0) return [];

    const queryTokenSet = new Set(queryTokens);
    const results: LexicalSearchResult[] = [];

    for (const unit of units) {
      let docText = `${unit.title} ${unit.path || ''}`;
      if (isCodeSymbolUnit(unit)) {
        docText += ` ${unit.symbolName} ${unit.qualifiedName} ${unit.signature || ''}`;
      }

      const docTokens = this.tokenize(docText);
      if (docTokens.length === 0) continue;

      const docFreq = new Map<string, number>();
      for (const t of docTokens) {
        docFreq.set(t, (docFreq.get(t) || 0) + 1);
      }

      let score = 0;
      const matched: string[] = [];

      for (const q of queryTokenSet) {
        const count = docFreq.get(q);
        if (count) {
          matched.push(q);
          // TF weighted score
          const tf = Math.log(1 + count);
          // Length normalization factor
          const norm = 1.0 / Math.sqrt(docTokens.length);
          score += tf * norm;
        }
      }

      if (score > 0) {
        results.push({
          unitId: unit.id,
          score: Number(score.toFixed(4)),
          matchedTerms: matched,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3);
  }
}
