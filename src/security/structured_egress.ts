/**
 * SiftrCode V2 - Structured Sanitized Egress Gateway (Milestone Part VII Sections 17-19)
 * Structurally guarantees that external provider callbacks receive exclusively sanitized/redacted
 * data without closing over original raw/sensitive source or prompt text.
 */

import { DataClass, DataRights, isOperationPermitted } from '../rights/data_rights';
import { TrustLevel } from './trust';
import { SecretDetector, DefaultSecretDetector } from './secret_filter';

export interface EgressField {
  key: string;
  dataClass: DataClass;
  value: string;
}

export interface SanitizedEgressPayload {
  fields: Record<string, string>;
  redactionCount: number;
  redactedCategories: string[];
}

export interface StructuredEgressOptions {
  secretDetector?: SecretDetector;
  allowUntrustedEgress?: boolean;
}

export class StructuredEgressGateway {
  private secretDetector: SecretDetector;
  private allowUntrustedEgress: boolean;

  constructor(options: StructuredEgressOptions = {}) {
    this.secretDetector = options.secretDetector || new DefaultSecretDetector();
    this.allowUntrustedEgress = options.allowUntrustedEgress ?? false;
  }

  /**
   * Evaluates and sanitizes structured egress fields according to granular operation rights,
   * repository trust levels, and secret detection.
   *
   * Invariant: The provider callback receives strictly and only the SanitizedEgressPayload.
   */
  public async execute<T>(
    fields: EgressField[],
    trustLevel: TrustLevel,
    rights: DataRights,
    executeFn: (sanitized: SanitizedEgressPayload) => Promise<T>
  ): Promise<{ result: T; payload: SanitizedEgressPayload }> {
    // 1. Check top-level remote processing permission
    if (!rights.remoteProcessingAllowed) {
      throw new Error(
        'Egress blocked: Customer DataRights prohibits remote processing (remoteProcessingAllowed is false)'
      );
    }

    // 2. Check repository trust level (Part VIII Section 22)
    if (trustLevel === TrustLevel.UNTRUSTED && !this.allowUntrustedEgress) {
      throw new Error(
        'Egress blocked: UNTRUSTED context units are prohibited from remote provider transmission'
      );
    }

    let totalRedactions = 0;
    const redactedCategories = new Set<string>();
    const sanitizedFields: Record<string, string> = {};

    for (const f of fields) {
      // 3. Operation Rights Check (Part VI Section 14-16)
      // Check processing.remote specifically, distinct from retention permission
      if (rights.operationRights) {
        const canProcessRemote = isOperationPermitted(
          rights.operationRights,
          f.dataClass,
          'processing_remote'
        );
        if (!canProcessRemote) {
          throw new Error(
            `Egress blocked: DataClass "${f.dataClass}" does not permit remote processing in OperationRightsPolicy`
          );
        }
      }

      // External source trust constraints (Part VIII Section 22)
      if (trustLevel === TrustLevel.EXTERNAL_SOURCE && (f.dataClass === DataClass.RAW_SOURCE || f.dataClass === DataClass.SOURCE_SNIPPET)) {
        if (!rights.operationRights?.[f.dataClass]?.processing?.remote) {
          throw new Error(
            `Egress blocked: EXTERNAL_SOURCE unit requires explicit remote-processing permission for ${f.dataClass}`
          );
        }
      }

      // 4. Secret Detection & Redaction (Part VII Section 19)
      const secrets = this.secretDetector.detectSecrets(f.value);
      let sanitizedValue = f.value;
      if (secrets.length > 0) {
        totalRedactions += secrets.length;
        for (const s of secrets) {
          redactedCategories.add(s.rule);
        }
        sanitizedValue = this.secretDetector.redactSecrets(f.value);
      }

      sanitizedFields[f.key] = sanitizedValue;
    }

    const payload: SanitizedEgressPayload = {
      fields: sanitizedFields,
      redactionCount: totalRedactions,
      redactedCategories: Array.from(redactedCategories),
    };

    // 5. Execute callback strictly with sanitized payload
    const result = await executeFn(payload);
    return { result, payload };
  }
}
