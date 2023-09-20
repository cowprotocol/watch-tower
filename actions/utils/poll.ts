import {
  ConditionalOrderFactory,
  ConditionalOrderParams,
  DEFAULT_CONDITIONAL_ORDER_REGISTRY,
  PollParams,
  PollResult,
} from "@cowprotocol/cow-sdk";

// Watch-tower will index every block, so we will by default the processing block and not the latest.
const POLL_FROM_LATEST_BLOCK = true;

const ordersFactory = new ConditionalOrderFactory(
  DEFAULT_CONDITIONAL_ORDER_REGISTRY
);

export async function pollConditionalOrder(
  pollParams: PollParams,
  conditionalOrderParams: ConditionalOrderParams
): Promise<PollResult | undefined> {
  const order = ordersFactory.fromParams(conditionalOrderParams);

  if (!order) {
    return undefined;
  }
  const actualPollParams = POLL_FROM_LATEST_BLOCK
    ? { ...pollParams, blockInfo: undefined }
    : pollParams;

  console.log(
    `[polling] Polling for ${order.toString()} using block (${
      actualPollParams.blockInfo === undefined
        ? "latest"
        : actualPollParams.blockInfo.blockNumber
    })....`
  );
  return order.poll(actualPollParams);
}
