export interface WatchtowerOptions {
  publish: boolean;
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
  sentryDsn?: string;
  logglyToken?: string;
  oneShot: boolean;
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
