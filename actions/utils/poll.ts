import {
  ConditionalOrderFactory,
  ConditionalOrderParams,
  DEFAULT_CONDITIONAL_ORDER_REGSTRY,
  PollParams,
  PollResult,
} from "@cowprotocol/cow-sdk";

const ordersFactory = new ConditionalOrderFactory(
  DEFAULT_CONDITIONAL_ORDER_REGSTRY
);

export async function pollConditionalOrder(
  pollParams: PollParams,
  conditionalOrderParams: ConditionalOrderParams
): Promise<PollResult | undefined> {
  const order = ordersFactory.fromParams(conditionalOrderParams);

  if (!order) {
    return undefined;
  }

  return order.poll(pollParams);
}
