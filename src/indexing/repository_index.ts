import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { glob } from 'glob';
import { getSymbolParserForLanguage, LanguageSymbolParser, ParsedSymbol } from '../parsing';
import {
  ContextUnit,
  ContextUnitKind,
  CodeSymbolUnit,
  SymbolKind,
  generateSymbolUnitId,
  generateContextUnitId,
} from '../context/context_unit';
import { TrustLevel, RepositoryOrigin, RepositoryTrustPolicy } from '../security/trust';
import { IndexQuality, createDefaultIndexQuality } from './index_quality';

export interface IndexRepositoryOptions {
  repositoryId?: string;
  workspaceSnapshotId?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
  trustPolicy?: RepositoryTrustPolicy;
}

export interface IndexRepositoryResult {
  units: ContextUnit[];
  quality: IndexQuality;
  scannedFiles: number;
}

const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/benchmarks/**',
  '**/.next/**',
  '**/.venv/**',
  '**/__pycache__/**',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.svg',
  '**/*.ico',
  '**/*.woff',
  '**/*.woff2',
];

export function classifyArtifactKind(relPath: string): ContextUnitKind {
  const norm = relPath.replace(/\\/g, '/').toLowerCase();
  const basename = path.basename(norm);

  // 1. Lockfiles
  if (
    basename === 'package-lock.json' ||
    basename === 'pnpm-lock.yaml' ||
    basename === 'yarn.lock' ||
    basename === 'cargo.lock' ||
    basename === 'go.sum' ||
    basename === 'poetry.lock' ||
    basename === 'pipfile.lock' ||
    basename === 'gemfile.lock' ||
    basename === 'composer.lock'
  ) {
    return ContextUnitKind.LOCKFILE;
  }

  // 2. Manifests
  if (
    basename === 'package.json' ||
    basename === 'cargo.toml' ||
    basename === 'go.mod' ||
    basename === 'pyproject.toml' ||
    basename === 'requirements.txt' ||
    basename === 'gemfile' ||
    basename === 'composer.json' ||
    basename === 'pom.xml' ||
    basename === 'build.gradle'
  ) {
    return ContextUnitKind.MANIFEST;
  }

  // 3. Database Migrations
  if (
    norm.startsWith('migration') ||
    norm.includes('/migration') ||
    norm.startsWith('migrate') ||
    norm.includes('/migrate') ||
    norm.includes('alembic') ||
    norm.includes('flyway') ||
    basename.includes('migration')
  ) {
    return ContextUnitKind.MIGRATION;
  }

  // 4. Schemas
  if (
    norm.endsWith('.prisma') ||
    norm.endsWith('.graphql') ||
    norm.endsWith('.gql') ||
    norm.endsWith('.proto') ||
    norm.endsWith('schema.sql') ||
    basename.includes('openapi') ||
    basename.includes('swagger')
  ) {
    return ContextUnitKind.SCHEMA;
  }

  // 5. Tests
  if (
    norm.startsWith('test/') ||
    norm.startsWith('tests/') ||
    norm.startsWith('__tests__/') ||
    norm.includes('/test/') ||
    norm.includes('/tests/') ||
    norm.includes('/__tests__/') ||
    basename.endsWith('.test.ts') ||
    basename.endsWith('.test.js') ||
    basename.endsWith('.spec.ts') ||
    basename.endsWith('.spec.js') ||
    basename.endsWith('_test.go') ||
    basename.startsWith('test_') ||
    basename.endsWith('_test.py')
  ) {
    return ContextUnitKind.TEST;
  }

  // 6. Documentation
  if (
    norm.endsWith('.md') ||
    norm.endsWith('.markdown') ||
    norm.endsWith('.rst') ||
    basename.startsWith('readme') ||
    basename.startsWith('license') ||
    norm.startsWith('docs/') ||
    norm.includes('/docs/')
  ) {
    return ContextUnitKind.DOCUMENTATION;
  }

  // 7. Configuration
  if (
    basename.startsWith('tsconfig') ||
    basename.startsWith('.eslint') ||
    basename.startsWith('.prettier') ||
    basename.endsWith('.config.js') ||
    basename.endsWith('.config.ts') ||
    basename.endsWith('.config.mjs') ||
    basename.endsWith('.config.json') ||
    basename === 'dockerfile' ||
    basename.startsWith('docker-compose') ||
    basename.startsWith('.env')
  ) {
    return ContextUnitKind.CONFIG;
  }

  return ContextUnitKind.SOURCE_FILE;
}

export function classifyTrustLevel(
  relPath: string,
  kind: ContextUnitKind,
  policyOrOrigin?: RepositoryTrustPolicy | RepositoryOrigin
): TrustLevel {
  const norm = relPath.replace(/\\/g, '/').toLowerCase();

  // Invariant: node_modules and vendor are always DEPENDENCY regardless of repository origin (Section 30)
  if (norm.startsWith('node_modules/') || norm.startsWith('vendor/')) {
    return TrustLevel.DEPENDENCY;
  }

  // Invariant: build artifacts are always GENERATED regardless of repository origin (Section 30)
  if (norm.startsWith('dist/') || norm.startsWith('build/') || norm.endsWith('.min.js') || norm.includes('/generated/')) {
    return TrustLevel.GENERATED;
  }

  const origin = policyOrOrigin
    ? (typeof policyOrOrigin === 'object' && 'origin' in policyOrOrigin ? policyOrOrigin.origin : (policyOrOrigin as RepositoryOrigin))
    : RepositoryOrigin.LOCAL_FIRST_PARTY;

  // Derive ContextUnit trust from repository origin (Section 29)
  if (origin === RepositoryOrigin.DEPENDENCY) {
    return TrustLevel.DEPENDENCY;
  }
  if (origin === RepositoryOrigin.GENERATED) {
    return TrustLevel.GENERATED;
  }
  if (origin === RepositoryOrigin.CLONED_EXTERNAL) {
    return TrustLevel.EXTERNAL_SOURCE;
  }
  if (origin === RepositoryOrigin.UNKNOWN) {
    if (kind === ContextUnitKind.DOCUMENTATION) {
      return TrustLevel.UNTRUSTED;
    }
    return TrustLevel.EXTERNAL_SOURCE;
  }

  // LOCAL_FIRST_PARTY origin
  if (kind === ContextUnitKind.CONFIG || kind === ContextUnitKind.MANIFEST || kind === ContextUnitKind.LOCKFILE) {
    return TrustLevel.FIRST_PARTY_CONFIGURATION;
  }

  if (kind === ContextUnitKind.DOCUMENTATION) {
    return TrustLevel.FIRST_PARTY_DOCUMENTATION;
  }

  return TrustLevel.FIRST_PARTY_CODE;
}

export class RepositoryIndexer {
  /**
   * Indexes an entire repository directory and emits typed ContextUnits.
   */
  public async indexRepository(
    repoDir: string,
    options: IndexRepositoryOptions = {}
  ): Promise<IndexRepositoryResult> {
    const rootDir = path.resolve(repoDir);
    const repoId = options.repositoryId || 'root';
    const snapshotId = options.workspaceSnapshotId || 'snapshot_init';

    const excludes = options.excludePatterns
      ? [...DEFAULT_EXCLUDES, ...options.excludePatterns]
      : DEFAULT_EXCLUDES;

    const patterns = options.includePatterns && options.includePatterns.length > 0
      ? options.includePatterns
      : '**/*';

    const files = await glob(patterns, {
      cwd: rootDir,
      nodir: true,
      ignore: excludes,
    });

    const allUnits: ContextUnit[] = [];
    let parseErrors = 0;
    let parsedFiles = 0;

    for (const relFile of files) {
      const fullPath = path.join(rootDir, relFile);
      try {
        const units = await this.indexFile(fullPath, relFile, snapshotId, repoId, options.trustPolicy);
        allUnits.push(...units);
        parsedFiles++;
      } catch {
        parseErrors++;
      }
    }

    // Sort deterministically by unit ID
    allUnits.sort((a, b) => a.id.localeCompare(b.id));

    const parserCoverage = files.length > 0 ? (parsedFiles / files.length) : 1.0;
    const confidence = parseErrors === 0 ? 1.0 : Math.max(0.5, 1.0 - (parseErrors / Math.max(1, files.length)));

    const quality: IndexQuality = createDefaultIndexQuality({
      parserCoverage: Number(parserCoverage.toFixed(2)),
      preciseIndexAvailable: false,
      unresolvedReferences: 0,
      parseErrors,
      confidence: Number(confidence.toFixed(2)),
    });

    return {
      units: allUnits,
      quality,
      scannedFiles: files.length,
    };
  }

  /**
   * Indexes raw file content directly in memory, emitting file and symbol ContextUnits.
   */
  public indexContent(
    relPath: string,
    rawContent: string,
    snapshotId: string,
    repoId: string = 'root',
    trustOrPolicy?: TrustLevel | RepositoryTrustPolicy | RepositoryOrigin
  ): ContextUnit[] {
    const normPath = relPath.replace(/\\/g, '/');
    const kind = classifyArtifactKind(normPath);
    let trust: TrustLevel;

    if (trustOrPolicy && typeof trustOrPolicy === 'string' && Object.values(TrustLevel).includes(trustOrPolicy as TrustLevel)) {
      trust = trustOrPolicy as TrustLevel;
    } else {
      trust = classifyTrustLevel(normPath, kind, trustOrPolicy as RepositoryTrustPolicy | RepositoryOrigin);
    }

    const fileUnitId = generateContextUnitId(kind, repoId, normPath, normPath);
    const fileUnit: ContextUnit = {
      id: fileUnitId,
      kind,
      workspaceSnapshotId: snapshotId,
      repositoryId: repoId,
      path: normPath,
      title: path.basename(normPath),
      provenance: {
        sourceType: 'file',
        sourceUri: normPath,
        extractedBy: 'siftr-indexer',
        timestamp: new Date().toISOString(),
      },
      trustLevel: trust,
      metadata: {
        fileSize: rawContent.length,
        lines: rawContent.split('\n').length,
      },
    };

    const units: ContextUnit[] = [fileUnit];

    // If source file or test, extract code symbols
    const ext = path.extname(normPath).toLowerCase();
    const parser = getSymbolParserForLanguage(ext);
    if (parser) {
      const symbols = this.extractSymbolsWithParser(parser, rawContent, normPath, snapshotId, repoId, trust);
      units.push(...symbols);
    }

    return units;
  }

  /**
   * Indexes a single file on disk, emitting both the file ContextUnit and any discovered CodeSymbolUnits.
   */
  public async indexFile(
    fullPath: string,
    relPath: string,
    snapshotId: string,
    repoId: string = 'root',
    trustOrPolicy?: TrustLevel | RepositoryTrustPolicy | RepositoryOrigin
  ): Promise<ContextUnit[]> {
    const rawContent = fs.readFileSync(fullPath, 'utf-8');
    return this.indexContent(relPath, rawContent, snapshotId, repoId, trustOrPolicy);
  }

  /**
   * Extracts code symbols using a registered LanguageSymbolParser.
   */
  private extractSymbolsWithParser(
    parser: LanguageSymbolParser,
    code: string,
    relPath: string,
    snapshotId: string,
    repoId: string,
    trust: TrustLevel
  ): CodeSymbolUnit[] {
    const parsedList = parser.parseSymbols(code, relPath);
    const extractedBy = parser.language === 'typescript' ? 'typescript-ast' : `${parser.language}-parser`;
    return parsedList.map((parsed) =>
      this.convertParsedSymbolToUnit(parsed, code, relPath, snapshotId, repoId, trust, parser.language, extractedBy)
    );
  }

  private convertParsedSymbolToUnit(
    parsed: ParsedSymbol,
    code: string,
    relPath: string,
    snapshotId: string,
    repoId: string,
    trust: TrustLevel,
    language: string,
    extractedBy: string
  ): CodeSymbolUnit {
    const lines = code.split('\n');
    const symbolLines = lines.slice(parsed.startLine - 1, Math.min(parsed.endLine, lines.length));
    const symbolText = symbolLines.join('\n');
    const contentHash = crypto.createHash('sha256').update(symbolText).digest('hex').slice(0, 16);
    const id = generateSymbolUnitId(repoId, relPath, parsed.qualifiedName, parsed.symbolKind);

    const metadata: Record<string, unknown> = {
      ...parsed.metadata,
      startLine: parsed.startLine,
      endLine: parsed.endLine,
    };

    if (parsed.metadata?.skeletonSafetyOverride) {
      metadata.skeletonSafety = parsed.metadata.skeletonSafetyOverride;
    }

    return {
      id,
      kind: ContextUnitKind.CODE_SYMBOL,
      workspaceSnapshotId: snapshotId,
      repositoryId: repoId,
      path: relPath,
      title: parsed.qualifiedName,
      provenance: {
        sourceType: 'file',
        sourceUri: relPath,
        extractedBy,
        timestamp: new Date().toISOString(),
      },
      trustLevel: trust,
      metadata,
      symbolKind: parsed.symbolKind,
      symbolName: parsed.symbolName,
      qualifiedName: parsed.qualifiedName,
      language,
      startLine: parsed.startLine,
      endLine: parsed.endLine,
      sourceRange: {
        startByte: parsed.startByte,
        endByte: parsed.endByte,
        startLine: parsed.startLine,
        endLine: parsed.endLine,
      },
      signature: parsed.signature,
      contentHash,
    };
  }

  /**
   * Extracts TypeScript and JavaScript code symbols using TypeScript AST.
   */
  private extractTypeScriptSymbols(
    code: string,
    relPath: string,
    snapshotId: string,
    repoId: string,
    trust: TrustLevel
  ): CodeSymbolUnit[] {
    const parser = getSymbolParserForLanguage('.ts')!;
    return this.extractSymbolsWithParser(parser, code, relPath, snapshotId, repoId, trust);
  }

  /**
   * Extracts Python code symbols (classes, functions, methods).
   */
  private extractPythonSymbols(
    code: string,
    relPath: string,
    snapshotId: string,
    repoId: string,
    trust: TrustLevel
  ): CodeSymbolUnit[] {
    const parser = getSymbolParserForLanguage('.py')!;
    return this.extractSymbolsWithParser(parser, code, relPath, snapshotId, repoId, trust);
  }

  /**
   * Extracts Go code symbols (functions, methods, types, interfaces).
   */
  private extractGoSymbols(
    code: string,
    relPath: string,
    snapshotId: string,
    repoId: string,
    trust: TrustLevel
  ): CodeSymbolUnit[] {
    const parser = getSymbolParserForLanguage('.go')!;
    return this.extractSymbolsWithParser(parser, code, relPath, snapshotId, repoId, trust);
  }

  /**
   * Extracts Rust code symbols (functions, structs, traits).
   */
  private extractRustSymbols(
    code: string,
    relPath: string,
    snapshotId: string,
    repoId: string,
    trust: TrustLevel
  ): CodeSymbolUnit[] {
    const parser = getSymbolParserForLanguage('.rs')!;
    return this.extractSymbolsWithParser(parser, code, relPath, snapshotId, repoId, trust);
  }
}
