import { ConditionalOrderParams } from "@cowprotocol/cow-sdk";
import { IConditionalOrder, OrderStatus } from "../types";
export function formatStatus(status: OrderStatus) {
  switch (status) {
    case OrderStatus.FILLED:
      return "FILLED";
    case OrderStatus.SUBMITTED:
      return "SUBMITTED";
    default:
      return `UNKNOWN (${status})`;
  }
}

export class LowLevelError extends Error {
  data: string;
  constructor(msg: string, data: string) {
    super(msg);
    this.data = data;
    Object.setPrototypeOf(this, LowLevelError.prototype);
  }
}

/**
 * Converts the typechain conditional order params to the sdk conditional order params (simpler version of the same thing)
 *
 * Some issues of working with the Typechain types are:
 *  - ConditionalOrderParamsStruct: Some of the properties are BytesLike instead of string (e.g. staticInput). This makes the use of it more complicated, since we need to handle the Bytes case
 *  - ConditionalOrderParamsStructOutput: Its both an object an array. Has duplicated information, this makes it more verbose in the logs and to take more space in the database.
 */
export function toConditionalOrderParams({
  handler,
  salt,
  staticInput,
}:
  | IConditionalOrder.ConditionalOrderParamsStructOutput
  | IConditionalOrder.ConditionalOrderParamsStruct): ConditionalOrderParams {
  return {
    handler: handler.toString(),
    salt: salt.toString(),
    staticInput: staticInput.toString(),
  };
}
