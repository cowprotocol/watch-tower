import {
  ConditionalOrderFactory,
  DEFAULT_CONDITIONAL_ORDER_REGSTRY,
  PollResult,
  PollResultCode,
} from "@cowprotocol/cow-sdk";
import { utils } from "ethers";

import { ValidateOrderParams } from "./model";

const ordersFactory = new ConditionalOrderFactory(
  DEFAULT_CONDITIONAL_ORDER_REGSTRY
);

export async function pollConditionalOrder(
  params: ValidateOrderParams
): Promise<PollResult | undefined> {
  const { owner, chainId, conditionalOrderParams, provider } = params;

  const order = ordersFactory.fromParams(params.conditionalOrderParams);

  if (!order) {
    return undefined;
  }

  return order.poll(owner, chainId, provider);
}
