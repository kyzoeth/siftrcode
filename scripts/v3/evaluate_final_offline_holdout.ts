#!/usr/bin/env node
/**
 * SiftrCode V3.1 - Final Fresh Holdout Offline Evaluation CLI Runner (Phase 11)
 *
 * Evaluates the ranked plans returned by FrozenV2ContextProvider and LearnedV3ContextProvider
 * on the genuinely fresh, authentic 40-task natural holdout.
 */

import {
  runFinalOfflineEvaluation,
  FinalOfflineEvaluationOptions,
  FinalOfflineEvaluationReport,
} from '../../src/learning/evaluation/final_offline_evaluator';

export {
  runFinalOfflineEvaluation,
  FinalOfflineEvaluationOptions,
  FinalOfflineEvaluationReport,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const opts: FinalOfflineEvaluationOptions = {};
  for (const a of args) {
    if (a.startsWith('--limit=')) opts.maxTasks = parseInt(a.split('=')[1], 10);
    if (a.startsWith('--filter=')) opts.taskFilter = a.split('=')[1];
    if (a.startsWith('--candidate-budget=')) opts.candidateBudget = parseInt(a.split('=')[1], 10);
    if (a.startsWith('--token-budget=')) opts.tokenBudget = parseInt(a.split('=')[1], 10);
  }

  runFinalOfflineEvaluation(opts).catch((err) => {
    console.error('Fatal error during offline evaluation:', err);
    process.exit(1);
  });
}
