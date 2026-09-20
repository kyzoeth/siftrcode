export enum TrustLevel {
  FIRST_PARTY_CODE = 'FIRST_PARTY_CODE',
  FIRST_PARTY_CONFIGURATION = 'FIRST_PARTY_CONFIGURATION',
  FIRST_PARTY_DOCUMENTATION = 'FIRST_PARTY_DOCUMENTATION',
  GENERATED = 'GENERATED',
  DEPENDENCY = 'DEPENDENCY',
  EXTERNAL_SOURCE = 'EXTERNAL_SOURCE',
  UNTRUSTED = 'UNTRUSTED',
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
