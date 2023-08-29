import {
  ConditionalOrderFactory,
  DEFAULT_CONDITIONAL_ORDER_REGSTRY,
  PollResult,
} from "@cowprotocol/cow-sdk";

import { PollingParams } from "../model";

const ordersFactory = new ConditionalOrderFactory(
  DEFAULT_CONDITIONAL_ORDER_REGSTRY
);

export async function pollConditionalOrder(
  params: PollingParams
): Promise<PollResult | undefined> {
  const { owner, chainId, conditionalOrderParams, provider } = params;

  const order = ordersFactory.fromParams(conditionalOrderParams);

  if (!order) {
    return undefined;
  }

  return order.poll(owner, chainId, provider);
}
