/**
 * SiftrCode V2 - JEV Question Set V1 (Milestone Part IX Sections 23-25)
 * Versioned, immutable questions for evaluating context candidate utility.
 */

import { noul } from '@typesafe-ai/sdk';

export const JEV_QUESTION_SET_VERSION_V1 = 'jev-context-v1';

export const JEV_QUESTIONS_V1 = {
  semanticRelevance: noul(
    'Would access to this candidate materially help a coding agent understand or solve the task?'
  ),
  implementationNeeded: noul(
    'Is seeing the implementation/detail contained in this candidate likely necessary or materially useful for completing the task, rather than only knowing its name/signature?'
  ),
  likelyEditTarget: noul(
    'Is this candidate likely to require modification to successfully complete the task?'
  ),
  likelyRootCause: noul(
    'Is this candidate likely to contain, control, or directly explain the behavior that must change to solve the task?'
  ),
};

export type JevQuestionsType = typeof JEV_QUESTIONS_V1;
