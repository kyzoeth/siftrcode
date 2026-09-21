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

export interface EnforcedProviderCall<T> {
  providerName: string;
  units: ContextUnit[];
  contents: string[];
  rights: DataRights;
  execute: () => Promise<T>;
}

/**
 * Section 42: Enforced wrapper around provider calls (JEV, embeddings, rerankers, Siftr Cloud).
 * Verifies DataRights + TrustLevel + SecretFilter + EgressPolicy before any external transmission.
 */
export class EnforcedEgressGateway {
  private egressPolicy: ProviderEgressPolicy;

  constructor(egressPolicy?: ProviderEgressPolicy) {
    this.egressPolicy = egressPolicy || new ProviderEgressPolicy();
  }

  public async executeWithEgressEnforcement<T>(call: EnforcedProviderCall<T>): Promise<{
    result: T;
    egressDecisions: EgressCheckResult[];
  }> {
    const egressDecisions: EgressCheckResult[] = [];

    for (let i = 0; i < call.units.length; i++) {
      const unit = call.units[i];
      const content = call.contents[i] || '';
      const decision = this.egressPolicy.evaluateEgress(unit, content, call.rights);
      egressDecisions.push(decision);

      if (!decision.allowed) {
        throw new Error(
          `Egress security violation for provider "${call.providerName}": ${decision.reason || 'blocked by policy'}`
        );
      }
    }

    const result = await call.execute();
    return { result, egressDecisions };
  }

  public executeWithEgressEnforcementSync<T>(call: {
    providerName: string;
    units: ContextUnit[];
    contents: string[];
    rights: DataRights;
    executeSync: () => T;
  }): {
    result: T;
    egressDecisions: EgressCheckResult[];
  } {
    const egressDecisions: EgressCheckResult[] = [];

    for (let i = 0; i < call.units.length; i++) {
      const unit = call.units[i];
      const content = call.contents[i] || '';
      const decision = this.egressPolicy.evaluateEgress(unit, content, call.rights);
      egressDecisions.push(decision);

      if (!decision.allowed) {
        throw new Error(
          `Egress security violation for provider "${call.providerName}": ${decision.reason || 'blocked by policy'}`
        );
      }
    }

    const result = call.executeSync();
    return { result, egressDecisions };
  }
}
