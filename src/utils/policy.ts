import fetch from "node-fetch";

import { ConditionalOrderParams, SupportedChainId } from "@cowprotocol/cow-sdk";

export enum FilterAction {
  DROP,
  IGNORE,
  ACCEPT,
}

export interface FilterParams {
  owner: string;
  conditionalOrderParams: ConditionalOrderParams;
}

export class FilterPolicy {
  private static _instance: FilterPolicy | undefined;

  protected owners: Map<string, FilterAction> = new Map();
  protected handlers: Map<string, FilterAction> = new Map();

  setOwners(owners: Map<string, FilterAction>) {
    this.owners = owners;
  }

  setHandlers(handlers: Map<string, FilterAction>) {
    this.handlers = handlers;
  }

  preFilter({ owner, conditionalOrderParams }: FilterParams): FilterAction {
    const action =
      this.owners.get(owner) ||
      this.handlers.get(conditionalOrderParams.handler);

    if (action) {
      return action;
    }

    return FilterAction.ACCEPT;
  }
}

export interface Policy {
  owners: Map<string, FilterAction>;
  handlers: Map<string, FilterAction>;
}

export async function fetchPolicy(chainId: SupportedChainId): Promise<Policy> {
  const configResponse = await fetch(
    `https://raw.githubusercontent.com/cowprotocol/watch-tower/config/filter-policy-${chainId}.json`
  );

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
