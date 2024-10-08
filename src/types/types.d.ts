/* eslint-disable */
/**
 * This file was automatically generated by json-schema-to-typescript.
 * DO NOT MODIFY IT BY HAND. Instead, modify the source JSONSchema file,
 * and run json-schema-to-typescript to regenerate this file.
 */

export type FilterAction = "ACCEPT" | "DROP" | "SKIP";

export interface Config {
  networks: {
    name: string;
    rpc: string;
    deploymentBlock: number;
    watchdogTimeout?: number;
    /**
     * Throttle block processing to only process blocks every N blocks. Set to 1 to process every block (default), 2 to process every other block, etc.
     */
    processEveryNumBlocks?: number;
    orderBookApi?: string;
    pageSize?: number;
    filterPolicy: {
      defaultAction: FilterAction;
      conditionalOrderIds?: {
        [k: string]: FilterAction;
      };
      transactions?: {
        [k: string]: FilterAction;
      };
      owners?: {
        [k: string]: FilterAction;
      };
      handlers?: {
        [k: string]: FilterAction;
      };
    };
  }[];
}
