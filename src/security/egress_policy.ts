import { ContextUnit } from '../context/context_unit';
import { DataRights, DataClass, isDataClassPermitted } from '../rights/data_rights';
import { TrustLevel } from './trust';
import { SecretDetector, DefaultSecretDetector } from './secret_filter';

export interface EgressCheckResult {
  allowed: boolean;
  reason?: string;
  sanitizedContent?: string;
}

export interface EgressPolicyOptions {
  secretDetector?: SecretDetector;
  blockOnSecrets?: boolean; // If true, completely blocks units with secrets; if false, redacts secrets
  allowUntrustedEgress?: boolean; // default false
}

export class ProviderEgressPolicy {
  private secretDetector: SecretDetector;
  private blockOnSecrets: boolean;
  private allowUntrustedEgress: boolean;

  constructor(options: EgressPolicyOptions = {}) {
    this.secretDetector = options.secretDetector || new DefaultSecretDetector();
    this.blockOnSecrets = options.blockOnSecrets ?? true;
    this.allowUntrustedEgress = options.allowUntrustedEgress ?? false;
  }

  /**
   * Evaluates whether a ContextUnit and its content can egress to an external cloud provider.
   * Architectural invariant: Sensitive/prohibited ContextUnits cannot leave the local machine.
   */
  public evaluateEgress(
    unit: ContextUnit,
    content: string,
    rights: DataRights
  ): EgressCheckResult {
    // 1. Check if remote processing is permitted at all
    if (!rights.remoteProcessingAllowed) {
      return {
        allowed: false,
        reason: 'Remote processing disallowed by customer DataRights configuration (Section 12.6, 76)',
      };
    }

    // 2. Check trust level
    if (unit.trustLevel === TrustLevel.UNTRUSTED && !this.allowUntrustedEgress) {
      return {
        allowed: false,
        reason: 'ContextUnit trust level UNTRUSTED is prohibited from external provider egress (Section 68, 69)',
      };
    }

    // 3. Check data class permissions
    const rawSourcePermitted = isDataClassPermitted(rights, DataClass.RAW_SOURCE);
    const snippetPermitted = isDataClassPermitted(rights, DataClass.SOURCE_SNIPPET);
    if (!rawSourcePermitted && !snippetPermitted) {
      return {
        allowed: false,
        reason: 'DataRights prohibits raw source or snippet retention/transmission to external providers',
      };
    }

    // 4. Secret detection
    if (this.secretDetector.hasSecrets(content)) {
      if (this.blockOnSecrets) {
        return {
          allowed: false,
          reason: 'Sensitive secret detected in unit content; blocked by ProviderEgressPolicy (Section 69)',
        };
      } else {
        // Redact secrets
        const sanitized = this.secretDetector.redactSecrets(content);
        return {
          allowed: true,
          sanitizedContent: sanitized,
        };
      }
    }

    return {
      allowed: true,
      sanitizedContent: content,
    };
  }
}
