export interface LogOptions {
  logLevel: string;
}

export interface WatchtowerOptions extends LogOptions {
  dryRun: boolean;
}

export interface WatchtowerReplayOptions extends WatchtowerOptions {
  rpc: string;
}

export interface RunOptions extends WatchtowerOptions {
  rpc: string[];
  deploymentBlock: number[];
  pageSize: number;
  silent: boolean;
  slackWebhook?: string;
  oneShot: boolean;
  disableApi: boolean;
  apiPort: number;
  watchdogTimeout: number;
}

export type SingularRunOptions = Omit<RunOptions, "rpc" | "deploymentBlock"> & {
  rpc: string;
  deploymentBlock: number;
};

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
