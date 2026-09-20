import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as ts from 'typescript';
import { glob } from 'glob';
import {
  ContextUnit,
  ContextUnitKind,
  CodeSymbolUnit,
  SymbolKind,
  generateSymbolUnitId,
  generateContextUnitId,
} from '../context/context_unit';
import { TrustLevel } from '../security/trust';
import { IndexQuality, createDefaultIndexQuality } from './index_quality';

export interface IndexRepositoryOptions {
  repositoryId?: string;
  workspaceSnapshotId?: string;
  includePatterns?: string[];
  excludePatterns?: string[];
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

export function classifyTrustLevel(relPath: string, kind: ContextUnitKind): TrustLevel {
  const norm = relPath.replace(/\\/g, '/').toLowerCase();

  if (norm.startsWith('node_modules/') || norm.startsWith('vendor/')) {
    return TrustLevel.DEPENDENCY;
  }

  if (norm.startsWith('dist/') || norm.startsWith('build/') || norm.endsWith('.min.js')) {
    return TrustLevel.GENERATED;
  }

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
        const units = await this.indexFile(fullPath, relFile, snapshotId, repoId);
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
   * Indexes a single file, emitting both the file ContextUnit and any discovered CodeSymbolUnits.
   */
  public async indexFile(
    fullPath: string,
    relPath: string,
    snapshotId: string,
    repoId: string = 'root'
  ): Promise<ContextUnit[]> {
    const rawContent = fs.readFileSync(fullPath, 'utf-8');
    const normPath = relPath.replace(/\\/g, '/');
    const kind = classifyArtifactKind(normPath);
    const trust = classifyTrustLevel(normPath, kind);

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
    if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx') {
      const symbols = this.extractTypeScriptSymbols(rawContent, normPath, snapshotId, repoId, trust);
      units.push(...symbols);
    } else if (ext === '.py') {
      const symbols = this.extractPythonSymbols(rawContent, normPath, snapshotId, repoId, trust);
      units.push(...symbols);
    } else if (ext === '.go') {
      const symbols = this.extractGoSymbols(rawContent, normPath, snapshotId, repoId, trust);
      units.push(...symbols);
    } else if (ext === '.rs') {
      const symbols = this.extractRustSymbols(rawContent, normPath, snapshotId, repoId, trust);
      units.push(...symbols);
    }

    return units;
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
    const sourceFile = ts.createSourceFile(
      relPath,
      code,
      ts.ScriptTarget.Latest,
      true,
      relPath.endsWith('.tsx') || relPath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    const symbols: CodeSymbolUnit[] = [];

    const visit = (node: ts.Node, parentClass?: string) => {
      let symKind: SymbolKind | null = null;
      let symName = '';
      let qualName = '';
      let sig = '';

      if (ts.isFunctionDeclaration(node) && node.name) {
        symKind = SymbolKind.FUNCTION;
        symName = node.name.text;
        qualName = symName;
        sig = code.slice(node.getStart(sourceFile), (node.body?.getStart(sourceFile) ?? node.getEnd())).trim();
      } else if (ts.isClassDeclaration(node) && node.name) {
        symKind = SymbolKind.CLASS;
        symName = node.name.text;
        qualName = symName;
        const classFullText = code.slice(node.getStart(sourceFile), node.getEnd());
        const braceIdx = classFullText.indexOf('{');
        sig = braceIdx !== -1 ? classFullText.slice(0, braceIdx).trim() : `class ${symName}`;
      } else if (ts.isInterfaceDeclaration(node)) {
        symKind = SymbolKind.INTERFACE;
        symName = node.name.text;
        qualName = symName;
        const ifaceFullText = code.slice(node.getStart(sourceFile), node.getEnd());
        const braceIdx = ifaceFullText.indexOf('{');
        sig = braceIdx !== -1 ? ifaceFullText.slice(0, braceIdx).trim() : `interface ${symName}`;
      } else if (ts.isTypeAliasDeclaration(node)) {
        symKind = SymbolKind.TYPE_ALIAS;
        symName = node.name.text;
        qualName = symName;
        sig = `type ${symName}`;
      } else if (ts.isEnumDeclaration(node)) {
        symKind = SymbolKind.ENUM;
        symName = node.name.text;
        qualName = symName;
        sig = `enum ${symName}`;
      } else if (ts.isMethodDeclaration(node) && parentClass) {
        const nameNode = node.name;
        symName = nameNode ? nameNode.getText(sourceFile) : 'anonymous';
        symKind = SymbolKind.METHOD;
        qualName = `${parentClass}.${symName}`;
        sig = code.slice(node.getStart(sourceFile), (node.body?.getStart(sourceFile) ?? node.getEnd())).trim();
      }

      if (symKind && symName) {
        const startPos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
        const startLine = startPos.line + 1;
        const endLine = endPos.line + 1;
        const nodeText = code.slice(node.getStart(sourceFile), node.getEnd());
        const contentHash = crypto.createHash('sha256').update(nodeText).digest('hex').slice(0, 16);

        const id = generateSymbolUnitId(repoId, relPath, qualName, symKind);
        symbols.push({
          id,
          kind: ContextUnitKind.CODE_SYMBOL,
          workspaceSnapshotId: snapshotId,
          repositoryId: repoId,
          path: relPath,
          title: qualName,
          provenance: {
            sourceType: 'file',
            sourceUri: relPath,
            extractedBy: 'typescript-ast',
          },
          trustLevel: trust,
          metadata: {
            parentClass,
          },
          symbolKind: symKind,
          symbolName: symName,
          qualifiedName: qualName,
          language: 'typescript',
          startLine,
          endLine,
          signature: sig,
          contentHash,
        });
      }

      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        for (const member of node.members) {
          visit(member, className);
        }
      } else {
        ts.forEachChild(node, (child) => visit(child, parentClass));
      }
    };

    visit(sourceFile);
    return symbols;
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
    const lines = code.split('\n');
    const symbols: CodeSymbolUnit[] = [];
    let currentClass: string | null = null;
    let classIndent = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const indent = line.search(/\S|$/);
      const trimmed = line.trim();

      if (currentClass && indent <= classIndent && trimmed.length > 0 && !trimmed.startsWith('#')) {
        currentClass = null;
      }

      const classMatch = line.match(/^(\s*)class\s+([A-Za-z0-9_]+)/);
      if (classMatch) {
        currentClass = classMatch[2];
        classIndent = classMatch[1].length;
        const symKind = SymbolKind.CLASS;
        const qualName = currentClass;
        const id = generateSymbolUnitId(repoId, relPath, qualName, symKind);

        symbols.push({
          id,
          kind: ContextUnitKind.CODE_SYMBOL,
          workspaceSnapshotId: snapshotId,
          repositoryId: repoId,
          path: relPath,
          title: qualName,
          provenance: { sourceType: 'file', sourceUri: relPath, extractedBy: 'python-parser' },
          trustLevel: trust,
          metadata: {},
          symbolKind: symKind,
          symbolName: currentClass,
          qualifiedName: qualName,
          language: 'python',
          startLine: i + 1,
          endLine: i + 1,
          signature: trimmed,
          contentHash: crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 16),
        });
        continue;
      }

      const defMatch = line.match(/^(\s*)def\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)/);
      if (defMatch) {
        const funcName = defMatch[2];
        const isMethod = currentClass !== null && defMatch[1].length > classIndent;
        const symKind = isMethod ? SymbolKind.METHOD : SymbolKind.FUNCTION;
        const qualName = isMethod ? `${currentClass}.${funcName}` : funcName;
        const id = generateSymbolUnitId(repoId, relPath, qualName, symKind);

        symbols.push({
          id,
          kind: ContextUnitKind.CODE_SYMBOL,
          workspaceSnapshotId: snapshotId,
          repositoryId: repoId,
          path: relPath,
          title: qualName,
          provenance: { sourceType: 'file', sourceUri: relPath, extractedBy: 'python-parser' },
          trustLevel: trust,
          metadata: { parentClass: isMethod ? currentClass : undefined },
          symbolKind: symKind,
          symbolName: funcName,
          qualifiedName: qualName,
          language: 'python',
          startLine: i + 1,
          endLine: i + 1,
          signature: trimmed,
          contentHash: crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 16),
        });
      }
    }

    return symbols;
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
    const lines = code.split('\n');
    const symbols: CodeSymbolUnit[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Go function or method
      const funcMatch = line.match(/^\s*func\s+(?:\(\s*[^)]+\s*\)\s+)?([A-Za-z0-9_]+)/);
      if (funcMatch) {
        const name = funcMatch[1];
        const isMethod = line.includes('(') && line.indexOf('(') < line.indexOf(name);
        const symKind = isMethod ? SymbolKind.METHOD : SymbolKind.FUNCTION;
        const id = generateSymbolUnitId(repoId, relPath, name, symKind);

        symbols.push({
          id,
          kind: ContextUnitKind.CODE_SYMBOL,
          workspaceSnapshotId: snapshotId,
          repositoryId: repoId,
          path: relPath,
          title: name,
          provenance: { sourceType: 'file', sourceUri: relPath, extractedBy: 'go-parser' },
          trustLevel: trust,
          metadata: {},
          symbolKind: symKind,
          symbolName: name,
          qualifiedName: name,
          language: 'go',
          startLine: i + 1,
          endLine: i + 1,
          signature: trimmed.replace(/\{.*$/, '').trim(),
          contentHash: crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 16),
        });
        continue;
      }

      // Go struct or interface
      const typeMatch = line.match(/^\s*type\s+([A-Za-z0-9_]+)\s+(struct|interface)/);
      if (typeMatch) {
        const name = typeMatch[1];
        const isInterface = typeMatch[2] === 'interface';
        const symKind = isInterface ? SymbolKind.INTERFACE : SymbolKind.STRUCT;
        const id = generateSymbolUnitId(repoId, relPath, name, symKind);

        symbols.push({
          id,
          kind: ContextUnitKind.CODE_SYMBOL,
          workspaceSnapshotId: snapshotId,
          repositoryId: repoId,
          path: relPath,
          title: name,
          provenance: { sourceType: 'file', sourceUri: relPath, extractedBy: 'go-parser' },
          trustLevel: trust,
          metadata: {},
          symbolKind: symKind,
          symbolName: name,
          qualifiedName: name,
          language: 'go',
          startLine: i + 1,
          endLine: i + 1,
          signature: trimmed,
          contentHash: crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 16),
        });
      }
    }

    return symbols;
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
    const lines = code.split('\n');
    const symbols: CodeSymbolUnit[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      const fnMatch = line.match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/);
      if (fnMatch) {
        const name = fnMatch[1];
        const id = generateSymbolUnitId(repoId, relPath, name, SymbolKind.FUNCTION);

        symbols.push({
          id,
          kind: ContextUnitKind.CODE_SYMBOL,
          workspaceSnapshotId: snapshotId,
          repositoryId: repoId,
          path: relPath,
          title: name,
          provenance: { sourceType: 'file', sourceUri: relPath, extractedBy: 'rust-parser' },
          trustLevel: trust,
          metadata: {},
          symbolKind: SymbolKind.FUNCTION,
          symbolName: name,
          qualifiedName: name,
          language: 'rust',
          startLine: i + 1,
          endLine: i + 1,
          signature: trimmed.replace(/\{.*$/, '').trim(),
          contentHash: crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 16),
        });
        continue;
      }

      const structMatch = line.match(/^\s*(?:pub\s+)?struct\s+([A-Za-z0-9_]+)/);
      if (structMatch) {
        const name = structMatch[1];
        const id = generateSymbolUnitId(repoId, relPath, name, SymbolKind.STRUCT);

        symbols.push({
          id,
          kind: ContextUnitKind.CODE_SYMBOL,
          workspaceSnapshotId: snapshotId,
          repositoryId: repoId,
          path: relPath,
          title: name,
          provenance: { sourceType: 'file', sourceUri: relPath, extractedBy: 'rust-parser' },
          trustLevel: trust,
          metadata: {},
          symbolKind: SymbolKind.STRUCT,
          symbolName: name,
          qualifiedName: name,
          language: 'rust',
          startLine: i + 1,
          endLine: i + 1,
          signature: trimmed,
          contentHash: crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 16),
        });
        continue;
      }

      const traitMatch = line.match(/^\s*(?:pub\s+)?trait\s+([A-Za-z0-9_]+)/);
      if (traitMatch) {
        const name = traitMatch[1];
        const id = generateSymbolUnitId(repoId, relPath, name, SymbolKind.TRAIT);

        symbols.push({
          id,
          kind: ContextUnitKind.CODE_SYMBOL,
          workspaceSnapshotId: snapshotId,
          repositoryId: repoId,
          path: relPath,
          title: name,
          provenance: { sourceType: 'file', sourceUri: relPath, extractedBy: 'rust-parser' },
          trustLevel: trust,
          metadata: {},
          symbolKind: SymbolKind.TRAIT,
          symbolName: name,
          qualifiedName: name,
          language: 'rust',
          startLine: i + 1,
          endLine: i + 1,
          signature: trimmed,
          contentHash: crypto.createHash('sha256').update(trimmed).digest('hex').slice(0, 16),
        });
      }
    }

    return symbols;
  }
}
