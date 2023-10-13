export interface LogOptions {
  logLevel: string;
  databasePath: string;
}

export interface WatchtowerOptions extends LogOptions {
  dryRun: boolean;
}

export interface WatchtowerReplayOptions extends WatchtowerOptions {
  rpc: string;
}

export interface RunOptions extends WatchtowerOptions {
  pageSize: number;
  silent: boolean;
  slackWebhook?: string;
  oneShot: boolean;
  disableApi: boolean;
  apiPort: number;
  watchdogTimeout: number;
}

export interface RunSingleOptions extends RunOptions {
  rpc: string;
  deploymentBlock: number;
}

export interface RunMultiOptions extends RunOptions {
  rpcs: string[];
  deploymentBlocks: number[];
}

export interface ReplayBlockOptions extends WatchtowerReplayOptions {
  block: number;
}

export interface ReplayTxOptions extends WatchtowerReplayOptions {
  tx: string;
}

export interface DumpDbOptions extends LogOptions {
  chainId: number;
}

export type ToBlock = "latest" | number;

export * from "./model";
export * from "./generated";
export * from "./generated/ComposableCoW";
