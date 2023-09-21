export interface WatchtowerOptions {
  contract: string;
  publish: boolean;
}

export interface WatchtowerReplayOptions extends WatchtowerOptions {
  rpc: string;
}

export interface RunOptions extends WatchtowerOptions {
  rpc: string[];
  deploymentBlock: string[];
  pageSize: string;
}

export interface ReplayBlockOptions extends WatchtowerReplayOptions {
  block: string;
}

export interface ReplayTxOptions extends WatchtowerReplayOptions {
  tx: string;
}
