export interface WatchtowerOptions {
  publish: boolean;
}

export interface WatchtowerReplayOptions extends WatchtowerOptions {
  rpc: string;
}

export interface RunOptions extends WatchtowerOptions {
  rpc: string[];
  deploymentBlock: string[];
  pageSize: string;
  silent: boolean;
  slackWebhook?: string;
  sentryDsn?: string;
  logglyToken?: string;
  oneShot: boolean;
}

export type SingularRunOptions = Omit<RunOptions, "rpc" | "deploymentBlock"> & {
  rpc: string;
  deploymentBlock: string;
};

export interface ReplayBlockOptions extends WatchtowerReplayOptions {
  block: string;
}

export interface ReplayTxOptions extends WatchtowerReplayOptions {
  tx: string;
}
