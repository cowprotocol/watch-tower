export type LogOptions = {
  logLevel: string;
  databasePath: string;
};

export type WatchtowerOptions = LogOptions & {
  dryRun: boolean;
  silent: boolean;
  slackWebhook?: string;
  oneShot: boolean;
  disableApi: boolean;
  apiPort: number;
  owners?: string[];
};

export type RunOptions = WatchtowerOptions & {
  networks: Config["networks"];
};

export type ContextOptions = WatchtowerOptions & Config["networks"][number];

export type DumpDbOptions = LogOptions & {
  chainId: number;
};

export type ToBlock = "latest" | number;

export type OrderBookApi = string | undefined;

export * from "./model";
export * from "./generated";
export * from "./generated/ComposableCoW";
export type { Config } from "./types";
