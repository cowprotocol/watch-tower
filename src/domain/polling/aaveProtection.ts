import { Order } from "@cowprotocol/contracts";
import { SupportedChainId } from "@cowprotocol/cow-sdk";
import {
  BuyTokenDestination,
  OrderCreation,
  OrderKind as ApiOrderKind,
  SellTokenSource,
  SigningScheme,
} from "@cowprotocol/sdk-order-book";
import {
  PollResultCode,
  type PollResultErrors,
} from "@cowprotocol/sdk-composable";
import { ethers } from "ethers";

import type { ChainContext } from "../../services";
import { RPC_TIMEOUT_MS, isAaveProtectionOwner } from "../../services/chain";
import { AavePositionProtector__factory, ConditionalOrder } from "../../types";
import { TimeoutError, getLogger, withTimeout } from "../../utils";
import { HEALTH_FACTOR_UNIT } from "../../utils/units";

import {
  AAVE_ORDER_VALIDITY_SECONDS,
  AAVE_ORDERBOOK_TIMEOUT_MS,
  quoteAaveProtection,
  type AaveQuoteInputs,
} from "../aaveProtectionQuote";

import {
  MIN_ORDER_VALIDITY_SECONDS,
  apiErrorReason,
  pollTrackedOrder,
  retry,
  retryAfterEpoch,
  retryAt,
  stop,
  submitOrder,
} from "./aaveOrderAttempt";

const { AddressZero } = ethers.constants;

function requestTimeout(deadline: number) {
  const timeLeft = deadline - Date.now();
  if (timeLeft <= 0) throw new TimeoutError("Aave polling budget", 0);
  return Math.min(timeLeft, AAVE_ORDERBOOK_TIMEOUT_MS);
}

export function isAaveProtectionOrder(
  context: Pick<ChainContext, "chainId" | "aaveProtectionHandler">,
  handler: string
) {
  return (
    context.chainId === SupportedChainId.MAINNET &&
    context.aaveProtectionHandler?.toLowerCase() === handler.toLowerCase()
  );
}

async function prepareOrder(
  { contract, orderBookApi }: ChainContext,
  owner: string,
  params: ConditionalOrder["params"],
  ruleId: string,
  inputs: AaveQuoteInputs,
  blockNumber: number,
  validTo: number,
  deadline: number
) {
  const quote = await quoteAaveProtection(
    orderBookApi,
    owner,
    validTo,
    ruleId,
    inputs,
    requestTimeout(deadline)
  );
  if (quote.reason !== undefined) return retry(quote.reason);

  const { order } = quote;

  // Match the Quote struct in the Solidity handler.
  const offchainInput = ethers.utils.defaultAbiCoder.encode(
    [
      "tuple(uint256 sellAmount,uint256 buyAmount,string appDataSuffix,uint32 validTo)",
    ],
    [[order.sellAmount, order.buyAmount, quote.appDataSuffix, order.validTo]]
  );
  const previewTimeout = requestTimeout(deadline);
  // Use the same block for the position read and the order preview.
  const { order: returnedOrder, signature } = await withTimeout(
    contract.getTradeableOrderWithSignature(owner, params, offchainInput, [], {
      blockTag: blockNumber,
    }),
    previewTimeout,
    "Aave signature preview"
  );

  // Compare all fields in the on-chain tuple. Its three flags are hashed strings.
  const expected = {
    ...order,
    kind: ethers.utils.id(order.kind),
    sellTokenBalance: ethers.utils.id(order.sellTokenBalance),
    buyTokenBalance: ethers.utils.id(order.buyTokenBalance),
  };
  const method = "getTradeableOrderWithSignature";
  if (
    contract.interface.encodeFunctionResult(method, [
      returnedOrder,
      signature,
    ]) !==
    contract.interface.encodeFunctionResult(method, [expected, signature])
  ) {
    return stop("Aave signed order does not match the quote");
  }

  const payload: OrderCreation = {
    ...order,
    from: owner,
    appData: quote.appData,
    appDataHash: order.appData,
    quoteId: quote.quoteId,
    kind: ApiOrderKind.SELL,
    sellTokenBalance: SellTokenSource.ERC20,
    buyTokenBalance: BuyTokenDestination.ERC20,
    signingScheme: SigningScheme.EIP1271,
    signature,
  };
  return { payload, quote };
}

function ineligibleReason({
  config,
  healthFactor,
  debtAmount,
  allowance,
}: AaveQuoteInputs) {
  if (debtAmount.isZero())
    return "Aave position is outside the supported collateral, debt or mode";
  if (
    healthFactor.toBigInt() <= HEALTH_FACTOR_UNIT ||
    healthFactor.gt(config.triggerHF)
  ) {
    return "Aave health factor is outside the trigger range";
  }
  if (allowance.lt(config.cap))
    return "Aave collateral allowance is below the cap";
  return "Aave quote inputs are unavailable";
}

export async function pollAaveProtection(
  context: ChainContext,
  owner: string,
  conditionalOrder: ConditionalOrder,
  blockNumber: number,
  blockTimestamp: number,
  computeUid: (order: Order) => string,
  metricLabels: string[]
): Promise<PollResultErrors> {
  try {
    const { params } = conditionalOrder;
    if (!isAaveProtectionOwner(context, owner)) {
      return stop("Aave protection requires a configured protector owner");
    }

    // Leave time in the watchdog budget for other rules and the block checkpoint.
    const deadline =
      Date.now() +
      Math.min(RPC_TIMEOUT_MS, (context.watchdogTimeout * 1000) / 2);
    const ruleId = ethers.utils.hexlify(params.staticInput);
    if (
      conditionalOrder.composableCow.toLowerCase() !==
        context.contract.address.toLowerCase() ||
      conditionalOrder.proof !== null ||
      !ethers.utils.isHexString(ruleId, 32)
    ) {
      return stop(
        "Aave protection requires its single ComposableCoW registration"
      );
    }

    const protector = AavePositionProtector__factory.connect(
      owner,
      context.provider
    );
    const readQuoteInputs = () => {
      const timeout = requestTimeout(deadline);
      return withTimeout(
        protector.quoteInputs(ruleId, { blockTag: blockNumber }),
        timeout,
        "Aave quote inputs"
      );
    };
    const isActive = ({ borrower, config }: AaveQuoteInputs) =>
      borrower !== AddressZero &&
      (config.expiry === 0 || config.expiry > blockTimestamp);

    // Recover the saved UID first. A fresh quote can produce a different order.
    const tracked = context.dryRun
      ? undefined
      : conditionalOrder.aaveOrderAttempt;
    if (tracked) {
      const result = await pollTrackedOrder(
        context,
        tracked,
        blockTimestamp,
        async () => {
          const inputs = await readQuoteInputs();
          return isActive(inputs) && inputs.flashLender !== AddressZero;
        },
        metricLabels,
        deadline
      );
      if (result.result !== PollResultCode.DONT_TRY_AGAIN) return result;

      const inputs = await readQuoteInputs();
      if (!isActive(inputs) || inputs.config.expiry !== 0) return result;
      // An orderbook status alone does not rule out a fill on-chain.
      if (blockTimestamp <= tracked.validTo)
        return retryAt(
          tracked.validTo + 1,
          "Waiting for the previous Aave order to expire"
        );

      delete conditionalOrder.aaveOrderAttempt;
      return retry(
        "Previous Aave order expired. Check the standing rule again."
      );
    }

    const inputs = await readQuoteInputs();
    if (!isActive(inputs))
      return stop(`Aave rule ${ruleId} is no longer active`);
    const { borrower, config, healthFactor } = inputs;
    const orderDeadline = blockTimestamp + AAVE_ORDER_VALIDITY_SECONDS;
    const validTo = config.expiry
      ? Math.min(orderDeadline, config.expiry)
      : orderDeadline;
    if (validTo - blockTimestamp <= MIN_ORDER_VALIDITY_SECONDS) {
      return stop("Aave rule will expire before a CoW order can remain valid");
    }
    if (inputs.flashLender === AddressZero)
      return retry(ineligibleReason(inputs));

    const prepared = await prepareOrder(
      context,
      protector.address,
      params,
      ruleId,
      inputs,
      blockNumber,
      validTo,
      deadline
    );
    if ("result" in prepared) return prepared;
    const { payload, quote } = prepared;
    const uid = computeUid(quote.order);
    const log = getLogger({
      name: "aaveProtection",
      chainId: context.chainId,
      blockNumber,
    });
    log.info(
      "Aave protectable position",
      JSON.stringify({
        uid,
        borrower,
        ruleId,
        healthFactor: ethers.utils.formatEther(healthFactor),
        targetHealthFactor: ethers.utils.formatEther(config.targetHF),
        projectedHealthFactor: ethers.utils.formatEther(
          quote.projectedHealthFactor
        ),
        estimatedCollateralDebit: ethers.utils.formatUnits(
          quote.estimatedCollateralDebit,
          inputs.collateralDecimals
        ),
        minimumBuyAmount: ethers.utils.formatUnits(
          quote.order.buyAmount,
          inputs.debtDecimals
        ),
      })
    );
    if (context.dryRun) {
      const { appData: appDataHash, ...terms } = quote.order;
      log.info(
        "Aave dry run would submit order",
        JSON.stringify({
          uid,
          ...terms,
          from: owner,
          appDataHash,
          quoteId: payload.quoteId,
        })
      );

      return retryAt(validTo, "Aave dry run prepared an order");
    }

    return await submitOrder(
      context,
      conditionalOrder,
      { uid, validTo, payload, state: "pending" },
      blockTimestamp,
      metricLabels,
      deadline
    );
  } catch (error) {
    const cooldown = retryAfterEpoch(error, blockTimestamp);
    if (cooldown !== undefined)
      return retryAt(cooldown, "Aave quote rate limited");
    return retry(`Aave protection polling failed: ${apiErrorReason(error)}`);
  }
}
