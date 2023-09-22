import {
  ConditionalOrderFactory,
  ConditionalOrderParams,
  DEFAULT_CONDITIONAL_ORDER_REGISTRY,
  PollParams,
  PollResult,
} from "@cowprotocol/cow-sdk";

// Watch-tower will index every block, so we will by default the processing block and not the latest.
const POLL_FROM_LATEST_BLOCK = false;

const ordersFactory = new ConditionalOrderFactory(
  DEFAULT_CONDITIONAL_ORDER_REGISTRY
);

export async function pollConditionalOrder(
  pollParams: PollParams,
  conditionalOrderParams: ConditionalOrderParams,
  orderRef: string
): Promise<PollResult | undefined> {
  const prefix = `[polling::${orderRef}]`;
  const order = ordersFactory.fromParams(conditionalOrderParams);

  if (!order) {
    return undefined;
  }
  const actualPollParams = POLL_FROM_LATEST_BLOCK
    ? { ...pollParams, blockInfo: undefined }
    : pollParams;

  const orderId = order.id;
  const orderString = order.toString();

  console.log(
    `[polling] Polling for ${
      orderString.includes(orderId)
        ? orderString
        : `Order (${orderId}) ${orderString}`
    } using block (${
      actualPollParams.blockInfo === undefined
        ? "latest"
        : actualPollParams.blockInfo.blockNumber
    })....`
  );

  return order.poll(actualPollParams);
}
