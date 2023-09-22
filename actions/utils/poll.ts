import {
  ConditionalOrderFactory,
  ConditionalOrderParams,
  DEFAULT_CONDITIONAL_ORDER_REGISTRY,
  PollParams,
  PollResult,
} from "@cowprotocol/cow-sdk";
import { type } from "os";

// Watch-tower will index every block, so we will by default the processing block and not the latest.
const POLL_FROM_LATEST_BLOCK = false;

const ordersFactory = new ConditionalOrderFactory(
  DEFAULT_CONDITIONAL_ORDER_REGISTRY
);

export type PollConditionalOrder = {
  conditionalOrderId: string;
  pollResult: PollResult;
};

export async function pollConditionalOrder(
  pollParams: PollParams,
  conditionalOrderParams: ConditionalOrderParams,
  orderRef: string
): Promise<PollConditionalOrder | undefined> {
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
    `${prefix} Polling for ${
      orderString.includes(orderId)
        ? orderString
        : `Order (${orderId}) ${orderString}`
    } using block (${
      actualPollParams.blockInfo === undefined
        ? "latest"
        : actualPollParams.blockInfo.blockNumber
    })....`
  );

  return {
    pollResult: await order.poll(actualPollParams),
    conditionalOrderId: orderId,
  };
}
