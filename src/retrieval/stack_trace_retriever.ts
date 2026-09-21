import { ContextUnit, isCodeSymbolUnit } from '../context/context_unit';
import { TaskContext } from '../context/task_context';
import { TaskEvidenceKind, StackTraceEvidence, TestFailureEvidence } from '../context/task_evidence';

export interface StackTraceMatchResult {
  unitId: string;
  matchedFrame: string;
  confidence: number;
}

export class StackTraceRetriever {
  /**
   * Matches failing stack trace frames and test failures directly against ContextUnits.
   */
  public retrieve(task: TaskContext, units: ContextUnit[]): StackTraceMatchResult[] {
    const matches: StackTraceMatchResult[] = [];

    for (const ev of task.evidence) {
      if (ev.kind === TaskEvidenceKind.STACK_TRACE) {
        const stack = ev as StackTraceEvidence;
        for (const frame of stack.frames) {
          this.matchFrame(frame.file, frame.functionName, units, matches);
        }
      } else if (ev.kind === TaskEvidenceKind.TEST_FAILURE) {
        const test = ev as TestFailureEvidence;
        if (test.testFilePath) {
          this.matchFrame(test.testFilePath, test.testName, units, matches);
        }
      }
    }

    return matches;
  }

  private matchFrame(
    filePath: string,
    functionName: string | undefined,
    units: ContextUnit[],
    results: StackTraceMatchResult[]
  ): void {
    const normTarget = filePath.replace(/\\/g, '/').toLowerCase();

    for (const unit of units) {
      if (!unit.path) continue;
      const normUnitPath = unit.path.replace(/\\/g, '/').toLowerCase();

      // Check path match
      if (normTarget.endsWith(normUnitPath) || normUnitPath.endsWith(normTarget)) {
        if (functionName && isCodeSymbolUnit(unit)) {
          const sym = unit.symbolName?.toLowerCase();
          const qual = unit.qualifiedName?.toLowerCase();
          const fn = functionName.toLowerCase();
          if ((sym && sym === fn) || (qual && qual.endsWith(fn))) {
            results.push({
              unitId: unit.id,
              matchedFrame: `${filePath}:${functionName}`,
              confidence: 1.0,
            });
            continue;
          }
        }

        // Matched file or symbol in file
        results.push({
          unitId: unit.id,
          matchedFrame: filePath,
          confidence: 0.9,
        });
      }
    }
  }
}
