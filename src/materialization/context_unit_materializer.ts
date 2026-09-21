import * as crypto from 'crypto';
import { ContextUnit, ContextUnitKind, CodeSymbolUnit, isCodeSymbolUnit, SymbolKind } from '../context/context_unit';
import {
  ContextResolution,
  ResolutionCapabilities,
  SkeletonSafetyLevel,
  isResolutionSupported,
} from '../context/context_resolution';
import { WorkspaceSnapshot } from '../workspace/workspace_snapshot';
import { AgentEnvironment } from '../agents/agent_environment';
import { WorkspaceSourceReader, DefaultWorkspaceSourceReader } from '../workspace/workspace_source_reader';
import { skeletonizeFile } from '../skeleton/dispatcher';

export interface MaterializedContext {
  contextUnitId: string;
  resolution: ContextResolution;
  content: string;
  actualTokenCount: number;
  sourcePath?: string;
  sourceRange?: {
    startLine: number;
    endLine: number;
    startByte?: number;
    endByte?: number;
  };
  contentHash: string;
  materializerVersion: string;
}

export interface ContextUnitMaterializer {
  materialize(
    unit: ContextUnit,
    resolution: ContextResolution,
    workspace: WorkspaceSnapshot,
    environment?: AgentEnvironment
  ): Promise<MaterializedContext>;

  materializeSync(
    unit: ContextUnit,
    resolution: ContextResolution,
    workspace: WorkspaceSnapshot,
    environment?: AgentEnvironment
  ): MaterializedContext;

  supports(unitOrKind: ContextUnit | ContextUnitKind, resolution: ContextResolution): boolean;

  getResolutionCapabilities?(unit: ContextUnit): ResolutionCapabilities;

  getNearestSafeAlternative?(unit: ContextUnit, resolution: ContextResolution): ContextResolution;
}

export class DefaultContextUnitMaterializer implements ContextUnitMaterializer {
  public static readonly VERSION = '2.1.0';

  private sourceReader: WorkspaceSourceReader;

  constructor(sourceReader?: WorkspaceSourceReader) {
    this.sourceReader = sourceReader || new DefaultWorkspaceSourceReader();
  }

  /**
   * Section 38: Determines full ResolutionCapabilities for a ContextUnit,
   * explicitly evaluating non-code artifacts, Python decorators, Rust macros, and module initializations.
   */
  public getResolutionCapabilities(unit: ContextUnit): ResolutionCapabilities {
    const isCode =
      unit.kind === ContextUnitKind.CODE_SYMBOL ||
      unit.kind === ContextUnitKind.SOURCE_FILE ||
      unit.kind === ContextUnitKind.TEST;

    const reasonCodes: string[] = [];
    let skeletonSafety: SkeletonSafetyLevel = 'SAFE';

    // 1. Non-code artifacts (CONFIG, LOCKFILE, SCHEMA, MIGRATION, DOCUMENTATION, etc.)
    if (!isCode) {
      skeletonSafety = 'UNSAFE';
      reasonCodes.push('NON_CODE_ARTIFACT');
      return {
        supportsName: true,
        supportsSignature: false,
        supportsSkeleton: false,
        supportsBody: true,
        supportsFull: true,
        skeletonSafety: 'UNSAFE',
        reasonCodes,
      };
    }

    // 2. Explicit metadata safety override
    if (unit.metadata?.skeletonSafety === 'UNSAFE') {
      skeletonSafety = 'UNSAFE';
      reasonCodes.push(
        typeof unit.metadata?.safetyReason === 'string'
          ? unit.metadata.safetyReason
          : 'EXPLICIT_UNSAFE_METADATA'
      );
    }

    // 3. Python decorator case (Section 38)
    if (
      unit.metadata?.hasDecorators === true ||
      unit.metadata?.isDecorator === true ||
      unit.metadata?.hasUnsafeDecorators === true ||
      (unit.path?.endsWith('.py') && unit.metadata?.hasDecorators === true)
    ) {
      skeletonSafety = 'UNSAFE';
      reasonCodes.push('PYTHON_DECORATOR_UNSAFE');
    }

    // 4. Rust macro case (Section 38)
    if (
      unit.metadata?.hasMacros === true ||
      unit.metadata?.isMacro === true ||
      unit.metadata?.macroRules === true ||
      (unit.path?.endsWith('.rs') && unit.metadata?.hasMacros === true)
    ) {
      skeletonSafety = 'UNSAFE';
      reasonCodes.push('RUST_MACRO_UNSAFE');
    }

    // 5. Module initialization case (Section 38)
    if (
      unit.metadata?.isModuleInit === true ||
      unit.metadata?.isModuleInitialization === true ||
      (unit.path &&
        (unit.path.endsWith('/__init__.py') || unit.path === '__init__.py') &&
        unit.metadata?.hasTopLevelCode === true)
    ) {
      skeletonSafety = 'UNSAFE';
      reasonCodes.push('MODULE_INITIALIZATION_UNSAFE');
    }

    return {
      supportsName: true,
      supportsSignature: true,
      supportsSkeleton: skeletonSafety !== 'UNSAFE',
      supportsBody: true,
      supportsFull: true,
      skeletonSafety,
      reasonCodes,
    };
  }

  /**
   * Returns whether a given ContextUnit or ContextUnitKind supports the requested ContextResolution.
   * Section 6 & 38: Enforces ResolutionCapabilities as a runtime invariant.
   */
  public supports(unitOrKind: ContextUnit | ContextUnitKind, resolution: ContextResolution): boolean {
    if (resolution === ContextResolution.OMIT) {
      return true;
    }

    if (typeof unitOrKind === 'string') {
      if (resolution === ContextResolution.NAME || resolution === ContextResolution.FULL || resolution === ContextResolution.BODY) {
        return true;
      }
      if (resolution === ContextResolution.SKELETON || resolution === ContextResolution.SIGNATURE) {
        return (
          unitOrKind === ContextUnitKind.CODE_SYMBOL ||
          unitOrKind === ContextUnitKind.SOURCE_FILE ||
          unitOrKind === ContextUnitKind.TEST
        );
      }
      return false;
    }

    const caps = this.getResolutionCapabilities(unitOrKind);
    return isResolutionSupported(resolution, caps);
  }

  /**
   * Section 38: Computes the nearest safe alternative resolution when requested resolution is unsupported or unsafe.
   */
  public getNearestSafeAlternative(unit: ContextUnit, resolution: ContextResolution): ContextResolution {
    const caps = this.getResolutionCapabilities(unit);
    if (isResolutionSupported(resolution, caps)) {
      return resolution;
    }

    // Degrade safely: if SKELETON is unsafe, try SIGNATURE, then NAME
    if (resolution === ContextResolution.SKELETON) {
      if (isResolutionSupported(ContextResolution.SIGNATURE, caps)) {
        return ContextResolution.SIGNATURE;
      }
      return ContextResolution.NAME;
    }

    if (resolution === ContextResolution.SIGNATURE) {
      return ContextResolution.NAME;
    }

    if (resolution === ContextResolution.BODY || resolution === ContextResolution.FULL) {
      return ContextResolution.NAME;
    }

    return ContextResolution.NAME;
  }

  /**
   * Materializes a ContextUnit into its exact string representation based on assigned resolution.
   */
  public async materialize(
    unit: ContextUnit,
    resolution: ContextResolution,
    workspace: WorkspaceSnapshot,
    _environment?: AgentEnvironment
  ): Promise<MaterializedContext> {
    if (resolution === ContextResolution.OMIT) {
      return {
        contextUnitId: unit.id,
        resolution: ContextResolution.OMIT,
        content: '',
        actualTokenCount: 0,
        sourcePath: unit.path,
        contentHash: 'none',
        materializerVersion: DefaultContextUnitMaterializer.VERSION,
      };
    }

    // 1. Enforce ResolutionCapabilities safety runtime invariant (Section 38)
    let effectiveResolution: ContextResolution = resolution;
    if (!this.supports(unit, resolution)) {
      effectiveResolution = this.getNearestSafeAlternative(unit, resolution);
    }

    if (effectiveResolution === ContextResolution.OMIT) {
      return {
        contextUnitId: unit.id,
        resolution: ContextResolution.OMIT,
        content: '',
        actualTokenCount: 0,
        sourcePath: unit.path,
        contentHash: 'none',
        materializerVersion: DefaultContextUnitMaterializer.VERSION,
      };
    }

    // 2. Load file or raw content via WorkspaceSourceReader
    const rawContent = await this.loadSourceContent(unit, workspace);

    // 3. Dispatch to type-specific materialization
    let renderedContent: string;
    let sourceRange: MaterializedContext['sourceRange'] = undefined;

    if (unit.kind === ContextUnitKind.CODE_SYMBOL) {
      const symbolResult = this.materializeCodeSymbol(unit as CodeSymbolUnit, effectiveResolution, rawContent);
      renderedContent = symbolResult.content;
      sourceRange = symbolResult.sourceRange;
    } else {
      renderedContent = this.materializeGenericUnit(unit, effectiveResolution, rawContent);
    }

    const tokenCount = Math.ceil(renderedContent.length / 4);
    const contentHash = crypto.createHash('sha256').update(renderedContent).digest('hex');

    return {
      contextUnitId: unit.id,
      resolution: effectiveResolution,
      content: renderedContent,
      actualTokenCount: tokenCount,
      sourcePath: unit.path,
      sourceRange,
      contentHash,
      materializerVersion: DefaultContextUnitMaterializer.VERSION,
    };
  }

  /**
   * Synchronous variant of materialize.
   */
  public materializeSync(
    unit: ContextUnit,
    resolution: ContextResolution,
    workspace: WorkspaceSnapshot,
    _environment?: AgentEnvironment
  ): MaterializedContext {
    if (resolution === ContextResolution.OMIT) {
      return {
        contextUnitId: unit.id,
        resolution: ContextResolution.OMIT,
        content: '',
        actualTokenCount: 0,
        sourcePath: unit.path,
        contentHash: 'none',
        materializerVersion: DefaultContextUnitMaterializer.VERSION,
      };
    }

    let effectiveResolution: ContextResolution = resolution;
    if (!this.supports(unit, resolution)) {
      effectiveResolution = this.getNearestSafeAlternative(unit, resolution);
    }

    if (effectiveResolution === ContextResolution.OMIT) {
      return {
        contextUnitId: unit.id,
        resolution: ContextResolution.OMIT,
        content: '',
        actualTokenCount: 0,
        sourcePath: unit.path,
        contentHash: 'none',
        materializerVersion: DefaultContextUnitMaterializer.VERSION,
      };
    }

    const rawContent = this.loadSourceContentSync(unit, workspace);

    let renderedContent: string;
    let sourceRange: MaterializedContext['sourceRange'] = undefined;

    if (unit.kind === ContextUnitKind.CODE_SYMBOL) {
      const symbolResult = this.materializeCodeSymbol(unit as CodeSymbolUnit, effectiveResolution, rawContent);
      renderedContent = symbolResult.content;
      sourceRange = symbolResult.sourceRange;
    } else {
      renderedContent = this.materializeGenericUnit(unit, effectiveResolution, rawContent);
    }

    const tokenCount = Math.ceil(renderedContent.length / 4);
    const contentHash = crypto.createHash('sha256').update(renderedContent).digest('hex');

    return {
      contextUnitId: unit.id,
      resolution: effectiveResolution,
      content: renderedContent,
      actualTokenCount: tokenCount,
      sourcePath: unit.path,
      sourceRange,
      contentHash,
      materializerVersion: DefaultContextUnitMaterializer.VERSION,
    };
  }

  /**
   * Materializes a CodeSymbolUnit honoring the strict V2 semantics:
   * - NAME: Symbol kind, qualified name, and path.
   * - SIGNATURE: Real indexed signature (never 3-line file approximation).
   * - SKELETON: Scoped to symbol/class, not whole file.
   * - BODY: Indexed startLine-endLine range only (not whole file).
   * - FULL: Entire file.
   */
  private materializeCodeSymbol(
    unit: CodeSymbolUnit,
    resolution: ContextResolution,
    rawFileContent: string
  ): { content: string; sourceRange?: MaterializedContext['sourceRange'] } {
    const lines = rawFileContent ? rawFileContent.split('\n') : [];
    const hasValidLineRange = unit.startLine > 0 && unit.endLine >= unit.startLine && lines.length >= unit.startLine;

    const sourceRange: MaterializedContext['sourceRange'] = hasValidLineRange
      ? {
          startLine: unit.startLine,
          endLine: Math.min(unit.endLine, lines.length),
          startByte: unit.sourceRange?.startByte,
          endByte: unit.sourceRange?.endByte,
        }
      : undefined;

    switch (resolution) {
      case ContextResolution.NAME: {
        const symbolKindLabel = unit.symbolKind || 'SYMBOL';
        const qualName = unit.qualifiedName || unit.symbolName || unit.title;
        const filePath = unit.path || '';
        return {
          content: `${symbolKindLabel} ${qualName} ${filePath}`.trim(),
          sourceRange,
        };
      }

      case ContextResolution.SIGNATURE: {
        // Section 5: Use real indexed signature, never first-3-lines approximation!
        if (unit.signature && unit.signature.trim()) {
          const header = unit.path ? `// [SIGNATURE: ${unit.qualifiedName}] (${unit.path})\n` : '';
          return {
            content: `${header}${unit.signature.trim()}`,
            sourceRange,
          };
        }

        // If no explicit signature indexed, safely extract the declaration header from the body
        if (hasValidLineRange) {
          const declarationLine = lines[unit.startLine - 1].trim();
          return {
            content: `// [SIGNATURE: ${unit.qualifiedName}] (${unit.path || ''})\n${declarationLine}`,
            sourceRange,
          };
        }

        // Fallback to name declaration
        return {
          content: `// [SIGNATURE] ${unit.symbolKind || 'SYMBOL'} ${unit.qualifiedName || unit.title}`,
          sourceRange,
        };
      }

      case ContextResolution.SKELETON: {
        // Section 5: Scoped to relevant symbol/class/module.
        // If the symbol is a class, struct, or interface, skeletonize ONLY that block!
        if (
          unit.symbolKind === SymbolKind.CLASS ||
          unit.symbolKind === SymbolKind.INTERFACE ||
          unit.symbolKind === SymbolKind.STRUCT ||
          unit.symbolKind === SymbolKind.TRAIT
        ) {
          const classBlock = hasValidLineRange
            ? lines.slice(unit.startLine - 1, unit.endLine).join('\n')
            : rawFileContent;
          const ext = unit.path ? unit.path : '.ts';
          const skel = skeletonizeFile(classBlock, ext);
          const scopedContent = skel.skeletonContent || classBlock;
          const header = hasValidLineRange
            ? `// [SKELETON: ${unit.qualifiedName || unit.title}] (${unit.path || ''}:${unit.startLine}-${unit.endLine})\n`
            : '';
          return {
            content: `${header}${scopedContent.trim()}`,
            sourceRange,
          };
        }

        // For a method or function, its skeleton is its declaration signature with docstrings
        if (unit.symbolKind === SymbolKind.METHOD || unit.symbolKind === SymbolKind.FUNCTION) {
          if (unit.signature && unit.signature.trim()) {
            return {
              content: `// [SKELETON: ${unit.qualifiedName || unit.title}] (${unit.path || ''})\n${unit.signature.trim()};`,
              sourceRange,
            };
          }
          if (hasValidLineRange) {
            const sigLine = lines[unit.startLine - 1].trim();
            return {
              content: `// [SKELETON: ${unit.qualifiedName || unit.title}] (${unit.path || ''})\n${sigLine};`,
              sourceRange,
            };
          }
        }

        // Fallback: skeletonize raw file content if available
        if (rawFileContent && rawFileContent.trim()) {
          const ext = unit.path ? unit.path : '.ts';
          const skel = skeletonizeFile(rawFileContent, ext);
          if (skel.skeletonContent) {
            return {
              content: skel.skeletonContent.trim(),
              sourceRange,
            };
          }
        }

        return this.extractSymbolBody(unit, lines, sourceRange);
      }

      case ContextResolution.BODY: {
        // Section 5: Return ONLY the selected symbol implementation. BODY must NOT mean whole file!
        return this.extractSymbolBody(unit, lines, sourceRange);
      }

      case ContextResolution.FULL:
      default: {
        // FULL returns the entire file
        return {
          content: rawFileContent || `// ${unit.title} (${unit.path || ''})`,
          sourceRange,
        };
      }
    }
  }

  private extractSymbolBody(
    unit: CodeSymbolUnit,
    lines: string[],
    sourceRange?: MaterializedContext['sourceRange']
  ): { content: string; sourceRange?: MaterializedContext['sourceRange'] } {
    if (unit.startLine > 0 && unit.endLine >= unit.startLine && lines.length >= unit.startLine) {
      const symbolLines = lines.slice(unit.startLine - 1, Math.min(unit.endLine, lines.length));
      const bodyCode = symbolLines.join('\n');
      const header = `// [BODY: ${unit.qualifiedName}] (${unit.path || ''}:${unit.startLine}-${unit.endLine})\n`;
      return {
        content: `${header}${bodyCode}`,
        sourceRange,
      };
    }

    if (unit.metadata?.content && typeof unit.metadata.content === 'string') {
      return {
        content: unit.metadata.content,
        sourceRange,
      };
    }

    return {
      content: `// [BODY: ${unit.qualifiedName}] (source unavailable)`,
      sourceRange,
    };
  }

  /**
   * Materializes generic non-code ContextUnits.
   */
  private materializeGenericUnit(
    unit: ContextUnit,
    resolution: ContextResolution,
    rawContent: string
  ): string {
    switch (resolution) {
      case ContextResolution.NAME:
        return `// [${unit.kind}] ${unit.path || unit.title}`;

      case ContextResolution.SIGNATURE:
        if (unit.kind === ContextUnitKind.SOURCE_FILE || unit.kind === ContextUnitKind.TEST) {
          const lines = rawContent.split('\n');
          return lines.slice(0, 5).join('\n');
        }
        return `// [${unit.kind}] ${unit.path || unit.title}`;

      case ContextResolution.SKELETON:
        if (unit.kind === ContextUnitKind.SOURCE_FILE || unit.kind === ContextUnitKind.TEST) {
          const skel = skeletonizeFile(rawContent, unit.path || 'file.ts');
          return skel.skeletonContent || rawContent;
        }
        // Non-skeletonizable units degrade safely to NAME
        return `// [${unit.kind}] ${unit.path || unit.title}`;

      case ContextResolution.BODY:
      case ContextResolution.FULL:
      default:
        return rawContent || `// [${unit.kind}] ${unit.title}`;
    }
  }

  /**
   * Loads the raw file or metadata content for a unit synchronously using the WorkspaceSourceReader.
   */
  private loadSourceContentSync(unit: ContextUnit, snapshot: WorkspaceSnapshot): string {
    if (typeof unit.metadata?.content === 'string') {
      return unit.metadata.content;
    }

    if (unit.path) {
      const readResult = this.sourceReader.readFileSync(
        snapshot,
        unit.repositoryId || 'root',
        unit.path
      );

      if (readResult.status === 'OK') {
        return readResult.content;
      }

      if (readResult.status === 'WORKSPACE_CHANGED') {
        return `// [WORKSPACE_CHANGED] File ${unit.path} was modified after snapshot ${snapshot.workspaceSnapshotId}\n${readResult.content}`;
      }
    }

    return `// ${unit.title} (${unit.path || 'in repository'})`;
  }

  /**
   * Loads the raw file or metadata content for a unit using the WorkspaceSourceReader.
   */
  private async loadSourceContent(unit: ContextUnit, snapshot: WorkspaceSnapshot): Promise<string> {
    if (typeof unit.metadata?.content === 'string') {
      return unit.metadata.content;
    }

    if (unit.path) {
      const readResult = await this.sourceReader.readFile(
        snapshot,
        unit.repositoryId || 'root',
        unit.path
      );

      if (readResult.status === 'OK') {
        return readResult.content;
      }

      if (readResult.status === 'WORKSPACE_CHANGED') {
        // Section 7: If workspace changed, return error header or propagate
        return `// [WORKSPACE_CHANGED] File ${unit.path} was modified after snapshot ${snapshot.workspaceSnapshotId}\n${readResult.content}`;
      }
    }

    return `// ${unit.title} (${unit.path || 'in repository'})`;
  }
}
