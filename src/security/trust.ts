/**
 * SiftrCode V2 - Trust Classification & Repository Trust Policies (Final Closure Directive Section 27-30)
 */

export enum TrustLevel {
  FIRST_PARTY_CODE = 'FIRST_PARTY_CODE',
  FIRST_PARTY_CONFIGURATION = 'FIRST_PARTY_CONFIGURATION',
  FIRST_PARTY_DOCUMENTATION = 'FIRST_PARTY_DOCUMENTATION',
  GENERATED = 'GENERATED',
  DEPENDENCY = 'DEPENDENCY',
  EXTERNAL_SOURCE = 'EXTERNAL_SOURCE',
  UNTRUSTED = 'UNTRUSTED',
}

export enum RepositoryOrigin {
  LOCAL_FIRST_PARTY = 'LOCAL_FIRST_PARTY',
  CLONED_EXTERNAL = 'CLONED_EXTERNAL',
  DEPENDENCY = 'DEPENDENCY',
  GENERATED = 'GENERATED',
  UNKNOWN = 'UNKNOWN',
}

export interface RepositoryTrustPolicy {
  repositoryId: string;
  origin: RepositoryOrigin;
  defaultTrustLevel: TrustLevel;
  source?: string;
  configuredAt: string;
}

export function createDefaultRepositoryTrustPolicy(params: {
  repositoryId: string;
  origin?: RepositoryOrigin;
  defaultTrustLevel?: TrustLevel;
  source?: string;
  configuredAt?: string;
}): RepositoryTrustPolicy {
  const origin = params.origin || RepositoryOrigin.LOCAL_FIRST_PARTY;
  let defaultTrustLevel = params.defaultTrustLevel;
  if (!defaultTrustLevel) {
    switch (origin) {
      case RepositoryOrigin.LOCAL_FIRST_PARTY:
        defaultTrustLevel = TrustLevel.FIRST_PARTY_CODE;
        break;
      case RepositoryOrigin.CLONED_EXTERNAL:
        defaultTrustLevel = TrustLevel.EXTERNAL_SOURCE;
        break;
      case RepositoryOrigin.DEPENDENCY:
        defaultTrustLevel = TrustLevel.DEPENDENCY;
        break;
      case RepositoryOrigin.GENERATED:
        defaultTrustLevel = TrustLevel.GENERATED;
        break;
      default:
        defaultTrustLevel = TrustLevel.UNTRUSTED;
        break;
    }
  }

  return {
    repositoryId: params.repositoryId,
    origin,
    defaultTrustLevel,
    source: params.source,
    configuredAt: params.configuredAt || new Date().toISOString(),
  };
}

export function isFirstParty(level: TrustLevel): boolean {
  return (
    level === TrustLevel.FIRST_PARTY_CODE ||
    level === TrustLevel.FIRST_PARTY_CONFIGURATION ||
    level === TrustLevel.FIRST_PARTY_DOCUMENTATION
  );
}

export function isTrusted(level: TrustLevel): boolean {
  return level !== TrustLevel.UNTRUSTED;
}
