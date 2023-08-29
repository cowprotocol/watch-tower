import { OrderStatus } from "../model";
import {
  ALL_SUPPORTED_CHAIN_IDS,
  SupportedChainId,
} from "@cowprotocol/cow-sdk";

type LocalChainId = 31337;
const LOCAL_CHAIN_ID = 31337;

export function toChainId(network: string): SupportedChainId {
  const neworkId = Number(network);
  const chainId = ALL_SUPPORTED_CHAIN_IDS.find((chain) => chain === neworkId);
  if (!chainId) {
    throw new Error(`Invalid network: ${network}`);
  }
  return chainId;
}

// TODO: If we use the Ordebook  API a lot of code will be deleted. Out of the scope of this PR (a lot has to be cleaned)
export function apiUrl(chainId: SupportedChainId | LocalChainId): string {
  switch (chainId) {
    case SupportedChainId.MAINNET:
      return "https://api.cow.fi/mainnet";
    case SupportedChainId.GOERLI:
      return "https://api.cow.fi/goerli";
    case SupportedChainId.GNOSIS_CHAIN:
      return "https://api.cow.fi/xdai";
    case LOCAL_CHAIN_ID:
      return "http://localhost:3000";
    default:
      throw "Unsupported network";
  }
}

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
