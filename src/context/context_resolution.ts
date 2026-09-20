export enum ContextResolution {
  OMIT = 0,
  NAME = 1,
  SIGNATURE = 2,
  SKELETON = 3,
  BODY = 4,
  FULL = 5,
}

export type SkeletonSafetyLevel = 'SAFE' | 'PARTIAL' | 'UNSAFE';

export interface ResolutionCapabilities {
  supportsName: boolean;
  supportsSignature: boolean;
  supportsSkeleton: boolean;
  supportsBody: boolean;
  supportsFull: boolean;
  skeletonSafety: SkeletonSafetyLevel;
  reasonCodes: string[];
}

export function isResolutionSupported(
  resolution: ContextResolution,
  capabilities: ResolutionCapabilities
): boolean {
  switch (resolution) {
    case ContextResolution.OMIT:
      return true;
    case ContextResolution.NAME:
      return capabilities.supportsName;
    case ContextResolution.SIGNATURE:
      return capabilities.supportsSignature;
    case ContextResolution.SKELETON:
      return capabilities.supportsSkeleton && capabilities.skeletonSafety !== 'UNSAFE';
    case ContextResolution.BODY:
      return capabilities.supportsBody;
    case ContextResolution.FULL:
      return capabilities.supportsFull;
    default:
      return false;
  }
}

export function getResolutionName(resolution: ContextResolution): string {
  switch (resolution) {
    case ContextResolution.OMIT:
      return 'OMIT';
    case ContextResolution.NAME:
      return 'NAME';
    case ContextResolution.SIGNATURE:
      return 'SIGNATURE';
    case ContextResolution.SKELETON:
      return 'SKELETON';
    case ContextResolution.BODY:
      return 'BODY';
    case ContextResolution.FULL:
      return 'FULL';
    default:
      return 'UNKNOWN';
  }
}
