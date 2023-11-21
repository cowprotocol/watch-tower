import { ConditionalOrderParams } from "@cowprotocol/cow-sdk";

export enum FilterAction {
  DROP = "DROP",
  SKIP = "SKIP",
  ACCEPT = "ACCEPT",
}

interface PolicyConfig {
  owners: Map<string, FilterAction>;
  handlers: Map<string, FilterAction>;
}

export interface FilterParams {
  owner: string;
  conditionalOrderParams: ConditionalOrderParams;
}

export interface FilterPolicyParams {
  configBaseUrl: string;
  // configAuthToken: string; // TODO: Implement authToken
}
export class FilterPolicy {
  protected configUrl: string;
  protected config: PolicyConfig | undefined;

  constructor({ configBaseUrl }: FilterPolicyParams) {
    this.configUrl = configBaseUrl;
  }

  /**
   * Decide if a conditional order should be processed, ignored, or dropped base in some filtering rules
   *
   * @param filterParams params required for the pre-filtering, including the conditional order params, chainId and the owner contract
   * @returns The action that should be performed with the conditional order
   */
  preFilter({ owner, conditionalOrderParams }: FilterParams): FilterAction {
    if (!this.config) {
      return FilterAction.ACCEPT;
    }

    const { owners, handlers } = this.config;

    const action =
      handlers.get(conditionalOrderParams.handler) || owners.get(owner);

    if (action) {
      return action;
    }

    return FilterAction.ACCEPT;
  }

  /**
   * Reloads the policies with their latest version
   */
  async reloadPolicies() {
    const policyConfig = await this.getConfig();

    if (policyConfig) {
      this.config = policyConfig;
    }
  }

  protected async getConfig(): Promise<PolicyConfig> {
    if (!this.configUrl) {
      throw new Error("configUrl must be defined");
    }
    const configResponse = await fetch(this.configUrl); // TODO: Implement authToken

    if (!configResponse.ok) {
      throw new Error(
        `Failed to fetch policy. Error ${
          configResponse.status
        }: ${await configResponse.text().catch(() => "")}`
      );
    }
    const config = await configResponse.json();
    return {
      owners: new Map(Object.entries(config.owners)),
      handlers: new Map(Object.entries(config.handlers)),
    };
  }
}
