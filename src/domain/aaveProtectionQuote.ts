import { Order, OrderBalance, OrderKind } from "@cowprotocol/contracts";
import {
  AppDataSdk,
  MAX_UINT256,
  ONE,
  bpsToPercentage,
} from "@cowprotocol/cow-sdk";
import {
  OrderBookApi,
  OrderKind as ApiOrderKind,
  type OrderQuoteRequest,
  OrderQuoteSideKindSell,
  PriceQuality,
  SigningScheme,
} from "@cowprotocol/sdk-order-book";
import { ethers } from "ethers";

import type { AavePositionProtector } from "../types/generated";
import { withTimeout } from "../utils/timeout";
import { BPS, HEALTH_FACTOR_UNIT, ceilDiv, tokenUnit } from "../utils/units";

// Size for 1.201 at a 1.20 target to allow for drift between quote and fill.
const QUOTE_TO_FILL_HF_MARGIN = ethers.utils.parseEther("0.001").toBigInt();
export const AAVE_ORDER_VALIDITY_SECONDS = 300;
export const AAVE_ORDERBOOK_TIMEOUT_MS = 15_000;
// Rounded up from the peak signature cost on the pinned V3 and V4 forks.
const AAVE_SIGNATURE_GAS = 150_000;
// The poller checks the UID itself after an uncertain POST.
export const SINGLE_ORDERBOOK_ATTEMPT = { backoffOpts: { numOfAttempts: 1 } };

const appDataSdk = new AppDataSdk();

export type AaveQuoteInputs = Awaited<
  ReturnType<AavePositionProtector["quoteInputs"]>
>;

type Asset = { balance: bigint; unit: bigint; price: bigint };

type Position = {
  collateral: Asset;
  debt: Asset;
  cap: bigint;
  target: bigint;
  liquidationThreshold: bigint;
  premiumBps: bigint;
  collateralDebitBuffer: bigint;
};

function adjustedCollateralAfterDebit(
  { collateral, liquidationThreshold }: Position,
  collateralDebit: bigint
) {
  const collateralValue =
    ((collateral.balance - collateralDebit) * collateral.price) /
    collateral.unit;
  return (collateralValue * liquidationThreshold) / BPS;
}

function healthAfterRepayment(
  position: Position,
  collateralDebit: bigint,
  proceeds: bigint
) {
  const { debt } = position;
  const remainingDebt = debt.balance - proceeds;
  if (remainingDebt <= 0n) return MAX_UINT256;

  // Round the debt value up so the quote check does not overstate HF.
  const debtValue = ceilDiv(remainingDebt * debt.price, debt.unit);
  return (
    (adjustedCollateralAfterDebit(position, collateralDebit) *
      HEALTH_FACTOR_UNIT) /
    debtValue
  );
}

function minimumHealthProceeds(position: Position, collateralDebit: bigint) {
  // Invert the rounded HF estimate to get a bound in debt-token base units.
  const { debt, target } = position;
  const maxDebtValue =
    (adjustedCollateralAfterDebit(position, collateralDebit) *
      HEALTH_FACTOR_UNIT) /
    target;
  const maxDebt = (maxDebtValue * debt.unit) / debt.price;
  return maxDebt >= debt.balance ? ONE : debt.balance - maxDebt;
}

// Flash-loan sizing

function estimateCollateralDebit(
  { premiumBps, collateralDebitBuffer }: Position,
  principal: bigint
) {
  return ceilDiv(principal * (BPS + premiumBps), BPS) + collateralDebitBuffer;
}

function maxPrincipalForDebit(
  { premiumBps, collateralDebitBuffer }: Position,
  collateralBudget: bigint
) {
  const headroom = collateralBudget - collateralDebitBuffer;
  return headroom > 0n ? (headroom * BPS) / (BPS + premiumBps) : 0n;
}

function sizeFlashLoan(position: Position, priceAfterDiscountBps: bigint) {
  const { collateral, debt, cap } = position;
  // The borrower approves the cap at setup. The UI can suggest enough to reach the target
  // at the price floor, with room for fees, premium, and rounding.
  // The quote only uses the smaller of that cap and supplied collateral, all-in.
  // The protector requires allowance covering the cap and checks actual spend on-chain.
  const collateralBudget = cap < collateral.balance ? cap : collateral.balance;
  const maxPrincipal = maxPrincipalForDebit(position, collateralBudget);
  if (maxPrincipal <= 0n) {
    throw new Error("Aave collateral budget is too small to quote");
  }

  if (healthAfterRepayment(position, 0n, 0n) >= position.target) {
    throw new Error(
      "The latest Aave collateral factor already meets the target. Refresh the position collateral configuration before selling."
    );
  }

  const target = position.target + QUOTE_TO_FILL_HF_MARGIN;
  const collateralValue =
    (collateral.balance * collateral.price) / collateral.unit;
  const debtValue = ceilDiv(debt.balance * debt.price, debt.unit);
  const liquidationThreshold =
    position.liquidationThreshold * HEALTH_FACTOR_UNIT;

  // Solve LT * (collateral value - sale value) >= target * (debt value - net sale value).
  const floorImprovement =
    target * priceAfterDiscountBps - liquidationThreshold;
  const improvement =
    floorImprovement > 0n
      ? floorImprovement
      : target * BPS - liquidationThreshold;
  if (improvement <= 0n) {
    throw new Error(
      "Aave target health factor is unreachable even at the Aave oracle price"
    );
  }
  const deficit =
    target * debtValue * BPS - collateralValue * liquidationThreshold;
  const requiredDebit = ceilDiv(
    deficit * collateral.unit,
    improvement * collateral.price
  );
  const floorPrincipal =
    maxPrincipalForDebit(position, requiredDebit - ONE) + ONE;
  const candidate =
    floorPrincipal < maxPrincipal ? floorPrincipal : maxPrincipal;

  // A live quote can beat the floor. Use the oracle price to check whether
  // the candidate, or the cap, can plausibly reach the target.
  const canReachTarget = (principal: bigint) => {
    const referenceProceeds =
      (principal * collateral.price * debt.unit) /
      (collateral.unit * debt.price);
    return (
      referenceProceeds >=
      minimumHealthProceeds(
        position,
        estimateCollateralDebit(position, principal)
      )
    );
  };
  if (canReachTarget(candidate)) return candidate;
  if (candidate < maxPrincipal && canReachTarget(maxPrincipal))
    return maxPrincipal;
  throw new Error(
    "Aave target health factor is unreachable even at the Aave oracle price"
  );
}

// CoW quote and position checks

export async function quoteAaveProtection(
  api: Pick<OrderBookApi, "getQuote">,
  protector: string,
  validTo: number,
  ruleId: string,
  inputs: AaveQuoteInputs,
  timeoutMs = AAVE_ORDERBOOK_TIMEOUT_MS
) {
  const { config, flashLender } = inputs;
  const position: Position = {
    collateral: {
      balance: inputs.collateralBalance.toBigInt(),
      unit: tokenUnit(inputs.collateralDecimals),
      price: inputs.collateralPrice.toBigInt(),
    },
    debt: {
      balance: inputs.debtAmount.toBigInt(),
      unit: tokenUnit(inputs.debtDecimals),
      price: inputs.debtPrice.toBigInt(),
    },
    cap: config.cap.toBigInt(),
    target: config.targetHF.toBigInt(),
    liquidationThreshold: inputs.liquidationThreshold.toBigInt(),
    premiumBps: inputs.premiumBps.toBigInt(),
    collateralDebitBuffer: inputs.collateralDebitBuffer.toBigInt(),
  };

  const { collateral, debt } = position;
  if (collateral.price <= 0n || debt.price <= 0n)
    throw new Error("Invalid Aave oracle price");
  const maxDiscount = BigInt(config.maxPriceDiscountBps);
  if (maxDiscount >= BPS) throw new Error("Invalid Aave oracle discount");
  const priceAfterDiscountBps = BPS - maxDiscount;

  // Convert collateral base units into debt-token base units at the price floor.
  const flashLoanPrincipal = sizeFlashLoan(position, priceAfterDiscountBps);
  const estimatedCollateralDebit = estimateCollateralDebit(
    position,
    flashLoanPrincipal
  );
  const minimumOracleProceeds = ceilDiv(
    estimatedCollateralDebit *
      collateral.price *
      debt.unit *
      priceAfterDiscountBps,
    debt.price * collateral.unit * BPS
  );
  const sellAmountBeforeFee = flashLoanPrincipal.toString();

  const ruleTag = `aave-rule-${ruleId.toLowerCase()}`;
  // Solvers use the flashloan metadata to borrow the sell token for settlement.
  const {
    metadata: { utm, ...metadata },
    ...document
  } = await appDataSdk.generateAppDataDoc({
    appCode: "aave-protection-poc",
    metadata: {
      utm: { utmContent: ruleTag },
      flashloan: {
        liquidityProvider: flashLender,
        protocolAdapter: protector,
        receiver: protector,
        token: config.collateralToken,
        amount: sellAmountBeforeFee,
      },
    },
  });
  // The handler hashes the same JSON bytes, so preserve the document's key order.
  const appDataPrefix = `{"metadata":{"utm":{"utmContent":"${ruleTag}"`;
  const appData = JSON.stringify({
    metadata: { utm: { utmContent: ruleTag, ...utm }, ...metadata },
    ...document,
  });
  if (!appData.startsWith(appDataPrefix)) {
    throw new Error("Aave appData does not match the handler prefix");
  }
  const appDataSuffix = appData.slice(appDataPrefix.length);
  const appDataHash = ethers.utils.id(appData);
  const terms = {
    sellToken: config.collateralToken,
    buyToken: config.debtToken,
    receiver: protector,
    validTo,
  };

  // The service supports this budget even when the SDK request type omits it.
  const request: OrderQuoteRequest & { verificationGasLimit: number } = {
    ...terms,
    from: protector,
    appData,
    appDataHash,
    kind: OrderQuoteSideKindSell.SELL,
    sellAmountBeforeFee,
    priceQuality: PriceQuality.OPTIMAL,
    signingScheme: SigningScheme.EIP1271,
    verificationGasLimit: AAVE_SIGNATURE_GAS,
  };
  const { id: quoteId, quote } = await withTimeout(
    api.getQuote(request, SINGLE_ORDERBOOK_ATTEMPT),
    Math.min(timeoutMs, AAVE_ORDERBOOK_TIMEOUT_MS),
    "Aave flash-loan quote"
  );

  // The order sells the full loan principal, including the quoted CoW fee.
  const quotedProceeds = BigInt(quote.buyAmount);
  if (
    quoteId === undefined ||
    quote.sellToken?.toLowerCase() !== terms.sellToken.toLowerCase() ||
    quote.buyToken?.toLowerCase() !== terms.buyToken.toLowerCase() ||
    quote.kind !== ApiOrderKind.SELL ||
    quote.validTo !== validTo ||
    quote.appDataHash !== appDataHash ||
    BigInt(quote.sellAmount) + BigInt(quote.feeAmount) !== flashLoanPrincipal ||
    quotedProceeds <= 0n
  ) {
    throw new Error("CoW returned an inconsistent flash-loan quote");
  }

  if (quotedProceeds < minimumOracleProceeds) {
    const discountPercent = bpsToPercentage(config.maxPriceDiscountBps);
    return {
      reason: `quote is more than ${discountPercent}% below the Aave oracle price after fees`,
    };
  }
  const minimumDebtProceeds = minimumHealthProceeds(
    position,
    estimatedCollateralDebit
  );
  if (quotedProceeds < minimumDebtProceeds)
    return { reason: "quote projects a health factor below the target" };

  // Sell quote IDs match the pair and sell amount. The signed buy limit can
  // allow price movement within the user's health factor and oracle bounds.
  const buyAmount =
    minimumDebtProceeds > minimumOracleProceeds
      ? minimumDebtProceeds
      : minimumOracleProceeds;

  return {
    order: {
      ...terms,
      appData: appDataHash,
      sellAmount: sellAmountBeforeFee,
      buyAmount: buyAmount.toString(),
      feeAmount: "0",
      kind: OrderKind.SELL,
      partiallyFillable: false,
      sellTokenBalance: OrderBalance.ERC20,
      buyTokenBalance: OrderBalance.ERC20,
    } satisfies Order,
    estimatedCollateralDebit,
    projectedHealthFactor: healthAfterRepayment(
      position,
      estimatedCollateralDebit,
      buyAmount
    ),
    appData,
    appDataSuffix,
    quoteId,
  };
}
