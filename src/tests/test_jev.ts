import { JevClient } from '../jev/client';

async function testJev() {
  console.log('🧪 Testing Jev Decision Client...\n');

  const jev = new JevClient(); // Local heuristic mode (no API key)

  const task = 'Fix authentication token expiration in JWT middleware';

  const testCases = [
    {
      file: 'src/middleware/auth.ts',
      symbols: ['authMiddleware', 'verifyToken', 'JwtPayload'],
      expected: 'RootCandidate'
    },
    {
      file: 'src/types/user.ts',
      symbols: ['User', 'UserSession', 'AuthHeader'],
      expected: 'TypeDependencyOnly'
    },
    {
      file: 'src/utils/math_calculator.ts',
      symbols: ['calculateSum', 'divideNumbers'],
      expected: 'DeadWeight'
    }
  ];

  console.log(`Task Prompt: "${task}"\n`);

  for (const tc of testCases) {
    const decision = await jev.evaluate(tc.file, tc.symbols, [], task);
    console.log(`File: ${tc.file}`);
    console.log(`  ➔ Decision:       ${decision.classification}`);
    console.log(`  ➔ Score:          ${decision.score}/10`);
    console.log(`  ➔ Critical Path:  ${decision.is_critical_path}`);
    console.log(`  ➔ Source:         ${decision.source}`);
    console.log(`  ➔ Match Expected: ${decision.classification === tc.expected ? '✔ PASS' : '❌ FAIL'}\n`);

    if (decision.classification !== tc.expected) {
      console.error(`Mismatch for ${tc.file}`);
      process.exit(1);
    }
  }

  console.log('🎉 Jev Decision Engine test passed successfully!');
}

testJev().catch((err) => {
  console.error('Jev Test Failed:', err);
  process.exit(1);
});
