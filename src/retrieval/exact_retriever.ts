import { ContextUnit, isCodeSymbolUnit } from '../context/context_unit';
import { TaskContext } from '../context/task_context';

export interface ExactMatchResult {
  unitId: string;
  matchedToken: string;
  matchType: 'symbol_name' | 'qualified_name' | 'path';
}

export class ExactRetriever {
  /**
   * Discovers exact symbol or path matches against task prompt and text evidence.
   */
  public retrieve(task: TaskContext, units: ContextUnit[]): ExactMatchResult[] {
    const textCorpus = [
      task.primaryPrompt,
      ...task.evidence.map((e) => {
        if ('prompt' in e) return String(e.prompt);
        if ('title' in e) return `${e.title} ${'body' in e ? e.body : ''}`;
        if ('rawTrace' in e) return String(e.rawTrace);
        if ('message' in e) return String(e.message);
        return '';
      }),
    ].join(' ');

    const tokens = new Set(
      textCorpus
        .split(/[^A-Za-z0-9_./-]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3)
    );

    const matches: ExactMatchResult[] = [];

    for (const unit of units) {
      // 1. Path match
      if (unit.path) {
        const basename = unit.path.split('/').pop() || '';
        if (tokens.has(unit.path) || tokens.has(basename)) {
          matches.push({
            unitId: unit.id,
            matchedToken: tokens.has(unit.path) ? unit.path : basename,
            matchType: 'path',
          });
          continue;
        }
      }

      // 2. Code symbol matches
      if (isCodeSymbolUnit(unit)) {
        if (tokens.has(unit.qualifiedName)) {
          matches.push({
            unitId: unit.id,
            matchedToken: unit.qualifiedName,
            matchType: 'qualified_name',
          });
        } else if (tokens.has(unit.symbolName)) {
          matches.push({
            unitId: unit.id,
            matchedToken: unit.symbolName,
            matchType: 'symbol_name',
          });
        }
      }
    }

    return matches;
  }
}
