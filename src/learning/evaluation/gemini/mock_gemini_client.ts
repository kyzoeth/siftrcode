/**
 * Hermetic Mock Client for Gemini Agent Harness Testing
 *
 * Enables running CI unit tests without network access or live credentials.
 */

export interface MockTurnBehavior {
  functionCalls?: Array<{ name: string; args: Record<string, any>; id?: string }>;
  text?: string;
  usage?: {
    promptTokens: number;
    outputTokens: number;
    thoughtsTokens?: number;
  };
  throwError?: Error;
}

export class MockGeminiClient {
  private turnIndex = 0;
  private readonly turns: MockTurnBehavior[];

  constructor(turns: MockTurnBehavior[]) {
    this.turns = turns;
  }

  public get models() {
    return {
      generateContent: async (_params: any): Promise<any> => {
        if (this.turnIndex >= this.turns.length) {
          return {
            text: 'I have finished inspecting the code.',
            functionCalls: undefined,
            candidates: [{ content: { role: 'model', parts: [{ text: 'I have finished inspecting the code.' }] } }],
            usageMetadata: {
              promptTokenCount: 100,
              candidatesTokenCount: 50,
              totalTokenCount: 150,
            },
          };
        }

        const behavior = this.turns[this.turnIndex++];
        if (behavior.throwError) {
          throw behavior.throwError;
        }

        const parts: any[] = [];
        if (behavior.text) {
          parts.push({ text: behavior.text });
        }
        if (behavior.functionCalls && behavior.functionCalls.length > 0) {
          for (let i = 0; i < behavior.functionCalls.length; i++) {
            const fc = behavior.functionCalls[i];
            parts.push({
              functionCall: {
                name: fc.name,
                args: fc.args,
                id: fc.id ?? `call_mock_${i}`,
              },
            });
          }
        }

        const resObj: any = {
          candidates: [
            {
              content: {
                role: 'model',
                parts,
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: behavior.usage?.promptTokens ?? 80,
            candidatesTokenCount: behavior.usage?.outputTokens ?? 40,
            thoughtsTokenCount: behavior.usage?.thoughtsTokens ?? 0,
            totalTokenCount: (behavior.usage?.promptTokens ?? 80) + (behavior.usage?.outputTokens ?? 40),
          },
        };

        if (behavior.text) {
          resObj.text = behavior.text;
        }
        if (behavior.functionCalls && behavior.functionCalls.length > 0) {
          resObj.functionCalls = behavior.functionCalls.map((fc, i) => ({
            name: fc.name,
            args: fc.args,
            id: fc.id ?? `call_mock_${i}`,
          }));
        }

        return resObj;
      },
    };
  }
}
