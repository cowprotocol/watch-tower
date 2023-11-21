export type LogOptions = {
  logLevel: string;
  databasePath: string;
};

export type WatchtowerOptions = LogOptions & {
  dryRun: boolean;
};

export type WatchtowerReplayOptions = WatchtowerOptions & {
  rpc: string;
};

export type RunOptions = WatchtowerOptions & {
  pageSize: number;
  silent: boolean;
  slackWebhook?: string;
  oneShot: boolean;
  disableApi: boolean;
  apiPort: number;
  owners?: string[];
};

export type OrderBookApi = string | undefined;

export type ChainConfigOptions = {
  rpc: string;
  deploymentBlock: number;
  watchdogTimeout: number;
  orderBookApi?: string;
  filterPolicyConfig?: string;
  // filterPolicyConfigAuthToken?: string; // TODO: Implement authToken
};

export type MultiChainConfigOptions = {
  rpcs: string[];
  deploymentBlocks: number[];
  watchdogTimeouts: number[];
  orderBookApis: (string | undefined)[];
  filterPolicyConfigFiles: (string | undefined)[];
};

export type RunSingleOptions = RunOptions & ChainConfigOptions;
export type RunMultiOptions = RunOptions & MultiChainConfigOptions;

export type ReplayBlockOptions = WatchtowerReplayOptions & {
  block: number;
};

export type ReplayTxOptions = WatchtowerReplayOptions & {
  tx: string;
};

export type DumpDbOptions = LogOptions & {
  chainId: number;
};

export type ToBlock = "latest" | number;

export * from "./model";
export * from "./generated";
export * from "./generated/ComposableCoW";
