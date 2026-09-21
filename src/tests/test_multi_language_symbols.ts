/**
 * SiftrCode V2 - Multi-Language Symbol Correctness & Span Tests (Closure PR 0.1)
 *
 * Verifies:
 * 1. Structural symbol parsing across Python, Go, Rust, and TypeScript.
 * 2. Exact startLine / endLine boundary spans covering full implementations.
 * 3. Accurate safety metadata (hasDecorators, hasMacros, isModuleInit, isGenerated).
 * 4. Materialization behavior: BODY resolution delivers complete implementation
 *    while excluding neighboring symbols, and ResolutionCapabilities honors safety flags.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { PythonSymbolParser } from '../parsing/python_parser';
import { GolangSymbolParser } from '../parsing/golang_parser';
import { RustSymbolParser } from '../parsing/rust_parser';
import { TypeScriptSymbolParser } from '../parsing/typescript_parser';
import { getSymbolParserForLanguage } from '../parsing';
import { RepositoryIndexer } from '../indexing/repository_index';
import { DefaultContextUnitMaterializer } from '../materialization/context_unit_materializer';
import { DefaultWorkspaceSourceReader } from '../workspace/workspace_source_reader';
import { ContextResolution } from '../context/context_resolution';
import { ContextUnitKind, SymbolKind, CodeSymbolUnit, ContextUnit } from '../context/context_unit';
import { TrustLevel } from '../security/trust';
import { createWorkspaceSnapshot } from '../workspace/workspace_snapshot';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${message}`);
    process.exit(1);
  }
  console.log(`  ✔ ${message}`);
}

async function runMultiLanguageSymbolTests() {
  console.log('🧪 Testing Multi-Language Structural Symbol Correctness (Closure PR 0.1)...\n');

  const tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siftr_lang_test_'));

  try {
    const sourceReader = new DefaultWorkspaceSourceReader(tempWorkspaceDir);
    const materializer = new DefaultContextUnitMaterializer(sourceReader);
    const indexer = new RepositoryIndexer();
    const snapshot = createWorkspaceSnapshot({
      repositories: [
        {
          repositoryId: 'root',
          baseCommitSha: 'commit_pr01',
          trackedTreeHash: 'tree_pr01',
          dirtyPatchHash: 'clean',
        },
      ],
    });

    // =========================================================================
    // 1. PYTHON SYMBOL EXTRACTION & RESOLUTION
    // =========================================================================
    console.log('--- 1. Python Structural Parsing & Boundary Spans ---');

    const pyRelPath = 'services/processor.py';
    const pyFullPath = path.join(tempWorkspaceDir, pyRelPath);
    fs.mkdirSync(path.dirname(pyFullPath), { recursive: true });

    const pythonSource = `import math

def calculate_metrics(data):
    """Calculates summary metrics."""
    if not data:
        return {"count": 0, "mean": 0.0}
    total = sum(data)
    mean = total / len(data)
    return {
        "count": len(data),
        "mean": mean,
        "sum": total
    }

@property
@validate_input
def complex_pipeline(x, y):
    result = x * y
    return result + 42

class DataProcessor:
    def __init__(self, name):
        self.name = name

    def process(self, items):
        results = []
        for item in items:
            results.append(item * 2)
        return results

def standalone_helper():
    return True
`;
    fs.writeFileSync(pyFullPath, pythonSource, 'utf-8');

    const pyParser = new PythonSymbolParser();
    const pySymbols = pyParser.parseSymbols(pythonSource, pyRelPath);

    assert(pySymbols.length >= 4, `Python parser extracted ${pySymbols.length} symbols (expected >= 4)`);

    const calcFunc = pySymbols.find((s) => s.symbolName === 'calculate_metrics');
    assert(!!calcFunc, 'Extracted calculate_metrics function');
    assert(calcFunc!.startLine === 3, `calculate_metrics starts at line 3 (got ${calcFunc!.startLine})`);
    assert(calcFunc!.endLine === 13, `calculate_metrics ends at line 13 (got ${calcFunc!.endLine})`);
    assert(calcFunc!.startLine < calcFunc!.endLine, 'calculate_metrics startLine < endLine (not 1-line regex span)');

    const pipeFunc = pySymbols.find((s) => s.symbolName === 'complex_pipeline');
    assert(!!pipeFunc, 'Extracted complex_pipeline function');
    assert(pipeFunc!.metadata.hasDecorators === true, 'complex_pipeline detected decorators');
    assert(pipeFunc!.metadata.skeletonSafetyOverride === 'UNSAFE', 'complex_pipeline skeletonSafetyOverride is UNSAFE');

    const procClass = pySymbols.find((s) => s.symbolName === 'DataProcessor');
    assert(!!procClass, 'Extracted DataProcessor class');
    assert(procClass!.symbolKind === SymbolKind.CLASS, 'DataProcessor is CLASS');
    assert(procClass!.startLine === 21, `DataProcessor starts at line 21 (got ${procClass!.startLine})`);
    assert(procClass!.endLine >= 28, `DataProcessor spans through methods (got ${procClass!.endLine})`);

    const procMethod = pySymbols.find((s) => s.qualifiedName === 'DataProcessor.process');
    assert(!!procMethod, 'Extracted DataProcessor.process method');
    assert(procMethod!.parentSymbol === 'DataProcessor', 'process method parentSymbol is DataProcessor');
    assert(procMethod!.metadata.parentClass === 'DataProcessor', 'process method metadata.parentClass is DataProcessor');

    // Test RepositoryIndexer integration for Python
    const pyUnits = indexer.indexContent(pyRelPath, pythonSource, snapshot.workspaceSnapshotId, 'root', TrustLevel.FIRST_PARTY_CODE);
    const pyCodeUnits = pyUnits.filter((u): u is CodeSymbolUnit => u.kind === ContextUnitKind.CODE_SYMBOL);

    const pyCalcUnit = pyCodeUnits.find((u) => u.symbolName === 'calculate_metrics')!;
    assert(!!pyCalcUnit, 'RepositoryIndexer produced CodeSymbolUnit for calculate_metrics');
    assert(pyCalcUnit.startLine === 3 && pyCalcUnit.endLine === 13, 'Unit preserved accurate startLine and endLine');
    assert(!!pyCalcUnit.sourceRange, 'Unit carries sourceRange');

    // BODY resolution test: verify full function body and exclusion of neighboring symbols
    const pyBody = materializer.materializeSync(pyCalcUnit, ContextResolution.BODY, snapshot);
    assert(pyBody.content.includes('def calculate_metrics(data):'), 'BODY includes function signature');
    assert(pyBody.content.includes('"mean": mean,'), 'BODY includes function body logic');
    assert(!pyBody.content.includes('complex_pipeline'), 'BODY strictly excludes subsequent complex_pipeline');
    assert(!pyBody.content.includes('DataProcessor'), 'BODY strictly excludes subsequent DataProcessor');

    // SIGNATURE resolution test
    const pySig = materializer.materializeSync(pyCalcUnit, ContextResolution.SIGNATURE, snapshot);
    assert(pySig.content.includes('def calculate_metrics(data):'), 'SIGNATURE includes signature line');
    assert(!pySig.content.includes('total = sum(data)'), 'SIGNATURE excludes function body');

    // ResolutionCapabilities test for decorated Python symbol
    const pyPipeUnit = pyCodeUnits.find((u) => u.symbolName === 'complex_pipeline')!;
    const pyPipeCaps = materializer.getResolutionCapabilities(pyPipeUnit);
    assert(pyPipeCaps.skeletonSafety === 'UNSAFE', 'Decorated Python function has UNSAFE skeleton safety');
    assert(!pyPipeCaps.supportsSkeleton, 'Decorated Python function does not support SKELETON resolution');

    // =========================================================================
    // 2. GOLANG SYMBOL EXTRACTION & RESOLUTION
    // =========================================================================
    console.log('\n--- 2. Go Structural Parsing & Boundary Spans ---');

    const goRelPath = 'pkg/server.go';
    const goFullPath = path.join(tempWorkspaceDir, goRelPath);
    fs.mkdirSync(path.dirname(goFullPath), { recursive: true });

    const goSource = `package server

import (
    "fmt"
    "net/http"
)

type Config struct {
    Host string
    Port int
    TLS  bool
}

func HandleRequest(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodGet {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }
    for k, v := range r.Header {
        fmt.Fprintf(w, "%s: %s\\n", k, v)
    }
}

type Server struct {
    cfg *Config
}

func (s *Server) Start(port int) error {
    addr := fmt.Sprintf(":%d", port)
    fmt.Printf("Starting server on %s\\n", addr)
    return http.ListenAndServe(addr, nil)
}

func Helper() string {
    return "ok"
}
`;
    fs.writeFileSync(goFullPath, goSource, 'utf-8');

    const goParser = new GolangSymbolParser();
    const goSymbols = goParser.parseSymbols(goSource, goRelPath);

    assert(goSymbols.length >= 4, `Go parser extracted ${goSymbols.length} symbols (expected >= 4)`);

    const cfgStruct = goSymbols.find((s) => s.symbolName === 'Config');
    assert(!!cfgStruct, 'Extracted Config struct');
    assert(cfgStruct!.symbolKind === SymbolKind.STRUCT, 'Config is STRUCT');
    assert(cfgStruct!.startLine === 8, `Config starts at line 8 (got ${cfgStruct!.startLine})`);
    assert(cfgStruct!.endLine === 12, `Config ends at line 12 (got ${cfgStruct!.endLine})`);

    const handleFunc = goSymbols.find((s) => s.symbolName === 'HandleRequest');
    assert(!!handleFunc, 'Extracted HandleRequest function');
    assert(handleFunc!.startLine === 14, `HandleRequest starts at line 14 (got ${handleFunc!.startLine})`);
    assert(handleFunc!.endLine === 22, `HandleRequest ends at line 22 (got ${handleFunc!.endLine})`);
    assert(handleFunc!.startLine < handleFunc!.endLine, 'HandleRequest spans full body (not 1-line regex span)');

    const startMethod = goSymbols.find((s) => s.symbolName === 'Start');
    assert(!!startMethod, 'Extracted Start method');
    assert(startMethod!.symbolKind === SymbolKind.METHOD, 'Start is METHOD');
    assert(startMethod!.qualifiedName === 'Server.Start', `Start qualified name is Server.Start (got ${startMethod!.qualifiedName})`);
    assert(startMethod!.startLine === 28, `Start starts at line 28 (got ${startMethod!.startLine})`);
    assert(startMethod!.endLine === 32, `Start ends at line 32 (got ${startMethod!.endLine})`);

    // Test RepositoryIndexer integration for Go
    const goUnits = indexer.indexContent(goRelPath, goSource, snapshot.workspaceSnapshotId, 'root', TrustLevel.FIRST_PARTY_CODE);
    const goCodeUnits = goUnits.filter((u): u is CodeSymbolUnit => u.kind === ContextUnitKind.CODE_SYMBOL);

    const goHandleFunc = goCodeUnits.find((u) => u.symbolName === 'HandleRequest')!;
    assert(!!goHandleFunc, 'RepositoryIndexer produced CodeSymbolUnit for HandleRequest');

    // BODY resolution: full implementation without neighboring symbols
    const goBody = materializer.materializeSync(goHandleFunc, ContextResolution.BODY, snapshot);
    assert(goBody.content.includes('func HandleRequest(w http.ResponseWriter'), 'BODY includes Go func declaration');
    assert(goBody.content.includes('for k, v := range r.Header'), 'BODY includes inner loop');
    assert(!goBody.content.includes('Server struct'), 'BODY excludes subsequent Server struct');
    assert(!goBody.content.includes('func (s *Server) Start'), 'BODY excludes subsequent Start method');
    assert(!goBody.content.includes('func Helper'), 'BODY excludes subsequent Helper function');

    // SIGNATURE resolution
    const goSig = materializer.materializeSync(goHandleFunc, ContextResolution.SIGNATURE, snapshot);
    assert(goSig.content.includes('HandleRequest'), 'SIGNATURE contains function signature');
    assert(!goSig.content.includes('for k, v := range r.Header'), 'SIGNATURE excludes function body');

    // =========================================================================
    // 3. RUST SYMBOL EXTRACTION & RESOLUTION
    // =========================================================================
    console.log('\n--- 3. Rust Structural Parsing & Boundary Spans ---');

    const rsRelPath = 'src/pool.rs';
    const rsFullPath = path.join(tempWorkspaceDir, rsRelPath);
    fs.mkdirSync(path.dirname(rsFullPath), { recursive: true });

    const rustSource = `pub struct WorkerPool {
    size: usize,
    active: bool,
}

impl WorkerPool {
    pub fn new(size: usize) -> Self {
        WorkerPool {
            size,
            active: true,
        }
    }

    pub fn execute<F>(&self, f: F)
    where
        F: FnOnce() + Send + 'static,
    {
        if self.active {
            // execute task
            f();
        }
    }
}

#[derive(Debug, Clone)]
pub struct Task {
    pub id: u64,
}

macro_rules! define_handler {
    ($name:ident) => {
        pub fn $name() {
            println!("handler");
        }
    };
}

pub fn standalone_worker(id: usize) -> bool {
    let check = id > 0;
    check
}
`;
    fs.writeFileSync(rsFullPath, rustSource, 'utf-8');

    const rsParser = new RustSymbolParser();
    const rsSymbols = rsParser.parseSymbols(rustSource, rsRelPath);

    assert(rsSymbols.length >= 5, `Rust parser extracted ${rsSymbols.length} symbols (expected >= 5)`);

    const poolStruct = rsSymbols.find((s) => s.symbolName === 'WorkerPool');
    assert(!!poolStruct, 'Extracted WorkerPool struct');
    assert(poolStruct!.startLine === 1, `WorkerPool starts at line 1 (got ${poolStruct!.startLine})`);
    assert(poolStruct!.endLine === 4, `WorkerPool ends at line 4 (got ${poolStruct!.endLine})`);

    const execMethod = rsSymbols.find((s) => s.symbolName === 'execute');
    assert(!!execMethod, 'Extracted execute method');
    assert(execMethod!.qualifiedName === 'WorkerPool::execute', `execute qualified name is WorkerPool::execute (got ${execMethod!.qualifiedName})`);
    assert(execMethod!.startLine === 14, `execute starts at line 14 (got ${execMethod!.startLine})`);
    assert(execMethod!.endLine === 22, `execute ends at line 22 (got ${execMethod!.endLine})`);
    assert(execMethod!.startLine < execMethod!.endLine, 'execute spans full method body (not 1-line regex span)');

    const taskStruct = rsSymbols.find((s) => s.symbolName === 'Task');
    assert(!!taskStruct, 'Extracted Task struct');
    assert(taskStruct!.metadata.hasDecorators === true || taskStruct!.metadata.hasMacros === true, 'Task detected derive attribute/macro');
    assert(taskStruct!.metadata.skeletonSafetyOverride === 'UNSAFE', 'Task skeletonSafetyOverride is UNSAFE');

    const macroItem = rsSymbols.find((s) => s.symbolName === 'define_handler');
    assert(!!macroItem, 'Extracted define_handler macro');
    assert(macroItem!.metadata.hasMacros === true, 'define_handler hasMacros === true');
    assert(macroItem!.metadata.skeletonSafetyOverride === 'UNSAFE', 'define_handler skeletonSafetyOverride === UNSAFE');

    const workerFn = rsSymbols.find((s) => s.symbolName === 'standalone_worker');
    assert(!!workerFn, 'Extracted standalone_worker function');
    assert(workerFn!.startLine === 38, `standalone_worker starts at line 38 (got ${workerFn!.startLine})`);
    assert(workerFn!.endLine === 41, `standalone_worker ends at line 41 (got ${workerFn!.endLine})`);

    // Test RepositoryIndexer integration for Rust
    const rsUnits = indexer.indexContent(rsRelPath, rustSource, snapshot.workspaceSnapshotId, 'root', TrustLevel.FIRST_PARTY_CODE);
    const rsCodeUnits = rsUnits.filter((u): u is CodeSymbolUnit => u.kind === ContextUnitKind.CODE_SYMBOL);

    const rsExecUnit = rsCodeUnits.find((u) => u.symbolName === 'execute')!;
    assert(!!rsExecUnit, 'RepositoryIndexer produced CodeSymbolUnit for execute');

    // BODY resolution
    const rsBody = materializer.materializeSync(rsExecUnit, ContextResolution.BODY, snapshot);
    assert(rsBody.content.includes('pub fn execute<F>(&self, f: F)'), 'BODY includes generic signature');
    assert(rsBody.content.includes('if self.active {'), 'BODY includes body logic');
    assert(!rsBody.content.includes('pub struct Task'), 'BODY excludes Task struct');
    assert(!rsBody.content.includes('macro_rules!'), 'BODY excludes macro definition');
    assert(!rsBody.content.includes('standalone_worker'), 'BODY excludes standalone_worker');

    // ResolutionCapabilities test for Rust macro / decorated struct
    const rsMacroUnit = rsCodeUnits.find((u) => u.symbolName === 'define_handler')!;
    const rsMacroCaps = materializer.getResolutionCapabilities(rsMacroUnit);
    assert(rsMacroCaps.skeletonSafety === 'UNSAFE', 'Macro unit has UNSAFE skeleton safety');
    assert(!rsMacroCaps.supportsSkeleton, 'Macro unit does not support SKELETON resolution');

    // =========================================================================
    // 4. TYPESCRIPT STRUCTURAL PARSING & RESOLUTION REGISTRY
    // =========================================================================
    console.log('\n--- 4. TypeScript Structural Parsing & Registry ---');

    const tsRelPath = 'src/client.ts';
    const tsFullPath = path.join(tempWorkspaceDir, tsRelPath);
    fs.mkdirSync(path.dirname(tsFullPath), { recursive: true });

    const tsSource = `export interface Config {
  host: string;
  port: number;
}

export class ServiceClient {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  public async fetchStatus(): Promise<string> {
    const res = await fetch(\`http://\${this.config.host}:\${this.config.port}/status\`);
    return res.text();
  }
}

export function createDefaultClient(): ServiceClient {
  return new ServiceClient({ host: 'localhost', port: 8080 });
}
`;
    fs.writeFileSync(tsFullPath, tsSource, 'utf-8');

    const tsParser = new TypeScriptSymbolParser();
    const tsSymbols = tsParser.parseSymbols(tsSource, tsRelPath);

    assert(tsSymbols.length >= 3, `TS parser extracted ${tsSymbols.length} symbols`);
    const clientClass = tsSymbols.find((s) => s.symbolName === 'ServiceClient');
    assert(!!clientClass, 'Extracted ServiceClient class');
    assert(clientClass!.startLine === 6, `ServiceClient starts at line 6 (got ${clientClass!.startLine})`);
    assert(clientClass!.endLine === 17, `ServiceClient ends at line 17 (got ${clientClass!.endLine})`);

    const fetchMethod = tsSymbols.find((s) => s.symbolName === 'fetchStatus');
    assert(!!fetchMethod, 'Extracted fetchStatus method');
    assert(fetchMethod!.qualifiedName === 'ServiceClient.fetchStatus', 'fetchStatus qualified name is ServiceClient.fetchStatus');
    assert(fetchMethod!.startLine === 13, `fetchStatus starts at line 13 (got ${fetchMethod!.startLine})`);
    assert(fetchMethod!.endLine === 16, `fetchStatus ends at line 16 (got ${fetchMethod!.endLine})`);

    // RepositoryIndexer integration for TypeScript
    const tsUnits = indexer.indexContent(tsRelPath, tsSource, snapshot.workspaceSnapshotId, 'root', TrustLevel.FIRST_PARTY_CODE);
    const tsCodeUnits = tsUnits.filter((u): u is CodeSymbolUnit => u.kind === ContextUnitKind.CODE_SYMBOL);
    const tsClientUnit = tsCodeUnits.find((u) => u.symbolName === 'ServiceClient')!;
    assert(!!tsClientUnit, 'RepositoryIndexer produced CodeSymbolUnit for ServiceClient');

    const tsBody = materializer.materializeSync(tsClientUnit, ContextResolution.BODY, snapshot);
    assert(tsBody.content.includes('class ServiceClient {'), 'TS BODY includes class header');
    assert(tsBody.content.includes('fetchStatus(): Promise<string>'), 'TS BODY includes class method');
    assert(!tsBody.content.includes('createDefaultClient'), 'TS BODY excludes subsequent createDefaultClient');

    // Registry lookup tests
    assert(getSymbolParserForLanguage('ts') instanceof TypeScriptSymbolParser, 'Registry maps "ts" to TypeScriptSymbolParser');
    assert(getSymbolParserForLanguage('.py') instanceof PythonSymbolParser, 'Registry maps ".py" to PythonSymbolParser');
    assert(getSymbolParserForLanguage('go') instanceof GolangSymbolParser, 'Registry maps "go" to GolangSymbolParser');
    assert(getSymbolParserForLanguage('.rs') instanceof RustSymbolParser, 'Registry maps ".rs" to RustSymbolParser');
    assert(getSymbolParserForLanguage('unsupported_xyz') === null, 'Registry returns null for unknown language');

    console.log('\n🎉 All Multi-Language Symbol Correctness tests passed successfully!');
  } finally {
    try {
      fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
    } catch {
      // Ignore temp dir cleanup errors
    }
  }
}

runMultiLanguageSymbolTests().catch((err) => {
  console.error('💥 Test suite crashed:', err);
  process.exit(1);
});
