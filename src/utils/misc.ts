import { OrderStatus } from "../types";
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
