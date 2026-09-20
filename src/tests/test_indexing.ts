import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  RepositoryIndexer,
  classifyArtifactKind,
  classifyTrustLevel
} from '../indexing/repository_index';
import { ContextUnitKind, SymbolKind, isCodeSymbolUnit, CodeSymbolUnit } from '../context/context_unit';
import { TrustLevel } from '../security/trust';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✔ ${msg}`);
}

async function runIndexingTests() {
  console.log('🧪 Testing Heterogeneous ContextUnit Indexing...\n');

  // 1. Artifact & Trust Classification
  console.log('--- 1. Artifact & Trust Classification ---');
  assert(classifyArtifactKind('package.json') === ContextUnitKind.MANIFEST, 'package.json is MANIFEST');
  assert(classifyArtifactKind('Cargo.toml') === ContextUnitKind.MANIFEST, 'Cargo.toml is MANIFEST');
  assert(classifyArtifactKind('package-lock.json') === ContextUnitKind.LOCKFILE, 'package-lock.json is LOCKFILE');
  assert(classifyArtifactKind('Cargo.lock') === ContextUnitKind.LOCKFILE, 'Cargo.lock is LOCKFILE');
  assert(classifyArtifactKind('tsconfig.json') === ContextUnitKind.CONFIG, 'tsconfig.json is CONFIG');
  assert(classifyArtifactKind('.eslintrc.js') === ContextUnitKind.CONFIG, '.eslintrc.js is CONFIG');
  assert(classifyArtifactKind('README.md') === ContextUnitKind.DOCUMENTATION, 'README.md is DOCUMENTATION');
  assert(classifyArtifactKind('schema.prisma') === ContextUnitKind.SCHEMA, 'schema.prisma is SCHEMA');
  assert(classifyArtifactKind('migrations/001_create_users.sql') === ContextUnitKind.MIGRATION, 'migration SQL is MIGRATION');
  assert(classifyArtifactKind('src/tests/user.test.ts') === ContextUnitKind.TEST, 'user.test.ts is TEST');
  assert(classifyArtifactKind('src/services/payment.ts') === ContextUnitKind.SOURCE_FILE, 'payment.ts is SOURCE_FILE');

  assert(
    classifyTrustLevel('package.json', ContextUnitKind.MANIFEST) === TrustLevel.FIRST_PARTY_CONFIGURATION,
    'Manifest is FIRST_PARTY_CONFIGURATION'
  );
  assert(
    classifyTrustLevel('README.md', ContextUnitKind.DOCUMENTATION) === TrustLevel.FIRST_PARTY_DOCUMENTATION,
    'README is FIRST_PARTY_DOCUMENTATION'
  );
  assert(
    classifyTrustLevel('src/auth.ts', ContextUnitKind.SOURCE_FILE) === TrustLevel.FIRST_PARTY_CODE,
    'Source file is FIRST_PARTY_CODE'
  );
  assert(
    classifyTrustLevel('node_modules/express/index.js', ContextUnitKind.SOURCE_FILE) === TrustLevel.DEPENDENCY,
    'node_modules file is DEPENDENCY'
  );

  // 2. Fixture Repository Creation & Indexing
  console.log('\n--- 2. Fixture Repository Indexing ---');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr-test-index-'));
  const srcDir = path.join(tempDir, 'src');
  const migDir = path.join(tempDir, 'migrations');
  const testDir = path.join(tempDir, 'tests');

  fs.mkdirSync(srcDir, { recursive: true });
  fs.mkdirSync(migDir, { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });

  fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name": "fixture-repo", "version": "1.0.0"}\n');
  fs.writeFileSync(path.join(tempDir, 'package-lock.json'), '{"lockfileVersion": 3}\n');
  fs.writeFileSync(path.join(tempDir, 'tsconfig.json'), '{"compilerOptions": {"target": "ES2022"}}\n');
  fs.writeFileSync(path.join(tempDir, 'README.md'), '# Fixture Repository\nDocumentation content here.\n');
  fs.writeFileSync(path.join(tempDir, 'schema.prisma'), 'model User { id Int @id }\n');
  fs.writeFileSync(path.join(migDir, '0001_init.sql'), 'CREATE TABLE users (id INT PRIMARY KEY);\n');

  // TS Source
  const tsContent = `
export interface UserSession {
  token: string;
}

export class AuthService {
  constructor(private key: string) {}

  public async authenticate(username: string): Promise<boolean> {
    return true;
  }
}

export function generateToken(): string {
  return "tok_123";
}
`;
  fs.writeFileSync(path.join(srcDir, 'auth.ts'), tsContent);

  // Python Source
  const pyContent = `
class CacheClient:
    def __init__(self, host: str):
        self.host = host

    def get(self, key: str) -> str:
        return "val"

def hash_key(k: str) -> str:
    return k.strip()
`;
  fs.writeFileSync(path.join(srcDir, 'cache.py'), pyContent);

  // Go Source
  const goContent = `
package main

type Storage interface {
    Save(data string) error
}

func ProcessEvent(event string) error {
    return nil
}
`;
  fs.writeFileSync(path.join(srcDir, 'storage.go'), goContent);

  // Rust Source
  const rsContent = `
pub struct Account {
    pub id: u64,
}

pub trait AccountManager {
    fn get_account(&self, id: u64) -> Option<Account>;
}

pub fn create_account() -> Account {
    Account { id: 1 }
}
`;
  fs.writeFileSync(path.join(srcDir, 'account.rs'), rsContent);

  // Test File
  fs.writeFileSync(path.join(testDir, 'auth.test.ts'), 'describe("Auth", () => { it("works", () => {}); });\n');

  try {
    const indexer = new RepositoryIndexer();
    const result1 = await indexer.indexRepository(tempDir, {
      repositoryId: 'fixture-repo',
      workspaceSnapshotId: 'ws_snap_1',
    });

    assert(result1.scannedFiles === 11, `Scanned all 11 fixture files (got ${result1.scannedFiles})`);
    assert(result1.units.length > 15, `Extracted heterogeneous units + code symbols (got ${result1.units.length})`);

    // Verify presence of all heterogeneous kinds
    const kindsPresent = new Set(result1.units.map((u) => u.kind));
    assert(kindsPresent.has(ContextUnitKind.MANIFEST), 'ContextUnitKind.MANIFEST present');
    assert(kindsPresent.has(ContextUnitKind.LOCKFILE), 'ContextUnitKind.LOCKFILE present');
    assert(kindsPresent.has(ContextUnitKind.CONFIG), 'ContextUnitKind.CONFIG present');
    assert(kindsPresent.has(ContextUnitKind.DOCUMENTATION), 'ContextUnitKind.DOCUMENTATION present');
    assert(kindsPresent.has(ContextUnitKind.SCHEMA), 'ContextUnitKind.SCHEMA present');
    assert(kindsPresent.has(ContextUnitKind.MIGRATION), 'ContextUnitKind.MIGRATION present');
    assert(kindsPresent.has(ContextUnitKind.TEST), 'ContextUnitKind.TEST present');
    assert(kindsPresent.has(ContextUnitKind.SOURCE_FILE), 'ContextUnitKind.SOURCE_FILE present');
    assert(kindsPresent.has(ContextUnitKind.CODE_SYMBOL), 'ContextUnitKind.CODE_SYMBOL present');

    // Verify TypeScript symbol details
    const tsSymbols = result1.units.filter((u) => isCodeSymbolUnit(u) && u.language === 'typescript') as CodeSymbolUnit[];
    const tsNames = tsSymbols.map((s) => s.qualifiedName);
    assert(tsNames.includes('UserSession'), 'Extracted UserSession interface');
    assert(tsNames.includes('AuthService'), 'Extracted AuthService class');
    assert(tsNames.includes('AuthService.authenticate'), 'Extracted AuthService.authenticate method');
    assert(tsNames.includes('generateToken'), 'Extracted generateToken function');

    const authMethod = tsSymbols.find((s) => s.qualifiedName === 'AuthService.authenticate')!;
    assert(authMethod.symbolKind === SymbolKind.METHOD, 'AuthService.authenticate has METHOD symbolKind');
    assert(Boolean(authMethod.signature && authMethod.signature.includes('authenticate(username: string): Promise<boolean>')), 'Signature captured cleanly');

    // Verify Python symbol details
    const pySymbols = result1.units.filter((u) => isCodeSymbolUnit(u) && u.language === 'python') as CodeSymbolUnit[];
    const pyNames = pySymbols.map((s) => s.qualifiedName);
    assert(pyNames.includes('CacheClient'), 'Extracted CacheClient python class');
    assert(pyNames.includes('CacheClient.get'), 'Extracted CacheClient.get python method');
    assert(pyNames.includes('hash_key'), 'Extracted hash_key python function');

    // Verify Go symbol details
    const goSymbols = result1.units.filter((u) => isCodeSymbolUnit(u) && u.language === 'go') as CodeSymbolUnit[];
    const goNames = goSymbols.map((s) => s.qualifiedName);
    assert(goNames.includes('Storage'), 'Extracted Storage go interface');
    assert(goNames.includes('ProcessEvent'), 'Extracted ProcessEvent go function');

    // Verify Rust symbol details
    const rsSymbols = result1.units.filter((u) => isCodeSymbolUnit(u) && u.language === 'rust') as CodeSymbolUnit[];
    const rsNames = rsSymbols.map((s) => s.qualifiedName);
    assert(rsNames.includes('Account'), 'Extracted Account rust struct');
    assert(rsNames.includes('AccountManager'), 'Extracted AccountManager rust trait');
    assert(rsNames.includes('create_account'), 'Extracted create_account rust function');

    // Verify IndexQuality
    assert(result1.quality.parserCoverage === 1.0, 'IndexQuality parser coverage is 1.0');
    assert(result1.quality.parseErrors === 0, 'IndexQuality parse errors is 0');
    assert(result1.quality.confidence === 1.0, 'IndexQuality confidence is 1.0');

    // 3. Determinism Verification
    console.log('\n--- 3. Indexing Determinism Check ---');
    const result2 = await indexer.indexRepository(tempDir, {
      repositoryId: 'fixture-repo',
      workspaceSnapshotId: 'ws_snap_1',
    });

    assert(result1.units.length === result2.units.length, 'Deterministic unit count across runs');
    for (let i = 0; i < result1.units.length; i++) {
      const u1 = result1.units[i];
      const u2 = result2.units[i];
      assert(u1.id === u2.id, `Unit ${i} stable ID match: ${u1.id}`);
      assert(u1.title === u2.title, `Unit ${i} title match: ${u1.title}`);
      assert(u1.kind === u2.kind, `Unit ${i} kind match: ${u1.kind}`);
    }

    console.log('\n🎉 All Heterogeneous ContextUnit Indexing tests passed successfully!');
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

runIndexingTests().catch((err) => {
  console.error('❌ Indexing test failed:', err);
  process.exit(1);
});
