import { Order } from "@cowprotocol/contracts";
import { BigNumber, ethers } from "ethers";

/**
 * Process an order to determine if it is valid
 * @param order The GPv2.Order data struct to validate
 * @throws Error if the order is invalid
 */
export function check(order: Order) {
  // amounts must be non-zero
  if (BigNumber.from(order.sellAmount).isZero()) {
    throw new Error("Order has zero sell amount");
  }

  if (BigNumber.from(order.buyAmount).isZero()) {
    throw new Error("Order has zero buy amount");
  }

  // token addresses must not be the ZeroAddress
  if (order.sellToken === ethers.constants.AddressZero) {
    throw new Error("Order has zero sell token address");
  }

  if (order.buyToken === ethers.constants.AddressZero) {
    throw new Error("Order has zero buy token address");
  }

  // tokens must not be the same
  if (order.sellToken === order.buyToken) {
    throw new Error("Order has identical sell and buy token addresses");
  }
}
