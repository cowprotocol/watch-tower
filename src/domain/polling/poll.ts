import { SupportedChainId } from "@cowprotocol/cow-sdk";
import {
  ConditionalOrderFactory,
  ConditionalOrderParams,
  DEFAULT_CONDITIONAL_ORDER_REGISTRY,
  PollParams,
  PollResult,
} from "@cowprotocol/sdk-composable";
import { getLogger } from "../../utils/logging";

// Watch-tower will index every block, so we will by default the processing block and not the latest.
const POLL_FROM_LATEST_BLOCK = false;

const ordersFactory = new ConditionalOrderFactory(
  DEFAULT_CONDITIONAL_ORDER_REGISTRY
);

export async function pollConditionalOrder(
  conditionalOrderId: string,
  pollParams: PollParams,
  conditionalOrderParams: ConditionalOrderParams,
  chainId: SupportedChainId,
  blockNumber: number,
  ownerNumber: number,
  orderNumber: number
): Promise<PollResult | undefined> {
  const log = getLogger({
    name: "pollConditionalOrder",
    chainId,
    blockNumber,
    ownerNumber,
    orderNumber,
  });

  const order = ordersFactory.fromParams(conditionalOrderParams);

  if (!order) {
    return undefined;
  }
  const actualPollParams = POLL_FROM_LATEST_BLOCK
    ? { ...pollParams, blockInfo: undefined }
    : pollParams;

  log.debug(
    `Polling id ${conditionalOrderId}. Order ${order.toString()} using block (${
      actualPollParams.blockInfo === undefined
        ? "latest"
        : actualPollParams.blockInfo.blockNumber
    })....`
  );
  return order.poll(actualPollParams);
}
