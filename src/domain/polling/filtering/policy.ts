import { ConditionalOrderParams } from "@cowprotocol/sdk-composable";

import { Config, FilterAction as FilterActionSchema } from "../../../types";

export enum FilterAction {
  DROP = "DROP",
  SKIP = "SKIP",
  ACCEPT = "ACCEPT",
}

export interface PolicyConfig {
  defaultAction: FilterAction;
  owners: Map<string, FilterAction>;
  handlers: Map<string, FilterAction>;
  transactions: Map<string, FilterAction>;
  conditionalOrderIds: Map<string, FilterAction>;
}

export type ActionsObject = {
  [k: string]: FilterAction;
};

export interface FilterParams {
  conditionalOrderId: string;
  transaction: string;
  owner: string;
  conditionalOrderParams: ConditionalOrderParams;
}

export class FilterPolicy {
  protected config: PolicyConfig | undefined;

  constructor(config: Config["networks"][number]["filterPolicy"]) {
    this.config = {
      defaultAction: FilterAction[config.defaultAction],
      owners: this.convertToMap(config.owners, true),
      handlers: this.convertToMap(config.handlers, true),
      transactions: this.convertToMap(config.transactions),
      conditionalOrderIds: this.convertToMap(config.conditionalOrderIds),
    };
  }

  /**
   * Decide if a conditional order should be processed, ignored, or dropped base in some filtering rules
   *
   * @param filterParams params required for the pre-filtering, including the conditional order params, chainId and the owner contract
   * @returns The action that should be performed with the conditional order
   */
  preFilter({
    conditionalOrderId: programmaticOrderId,
    transaction,
    owner,
    conditionalOrderParams,
  }: FilterParams): FilterAction {
    if (!this.config) {
      return FilterAction.ACCEPT;
    }

    const {
      owners,
      handlers,
      conditionalOrderIds: programmaticOrderIds,
      transactions,
    } = this.config;

    // Find the first matching rule
    const action =
      programmaticOrderIds.get(programmaticOrderId) ||
      transactions.get(transaction) ||
      owners.get(owner.toLowerCase()) ||
      handlers.get(conditionalOrderParams.handler.toLowerCase());

    if (action) {
      return action;
    }

    return this.config.defaultAction;
  }

  acceptsOwner(owner: string): boolean {
    return this.config?.owners.get(owner.toLowerCase()) === FilterAction.ACCEPT;
  }

  private convertToMap(
    object?: { [k: string]: FilterActionSchema },
    normalizeAddress = false
  ): Map<string, FilterAction> {
    return object
      ? new Map(
          Object.entries(object).map(([key, value]) => [
            normalizeAddress ? key.toLowerCase() : key,
            FilterAction[value],
          ])
        )
      : new Map<string, FilterAction>();
  }

  toJSON() {
    const {
      defaultAction,
      owners,
      handlers,
      transactions,
      conditionalOrderIds,
    } = this.config || {};
    return {
      defaultAction,
      owners: convertMapToObject(owners),
      handlers: convertMapToObject(handlers),
      transactions: convertMapToObject(transactions),
      conditionalOrderIds: convertMapToObject(conditionalOrderIds),
    };
  }
}
function convertMapToObject(map?: Map<string, FilterAction>): ActionsObject {
  return map ? Object.fromEntries(map.entries()) : {};
}
