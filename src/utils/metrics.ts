import client from "prom-client";

export class MetricsService {
  static apiRequestCounter = new client.Counter({
    name: "api_request_count",
    help: "Total number of API requests",
    labelNames: ["method", "path", "status"],
  });
  static blockWatcherBlockHeight = new client.Gauge({
    name: "block_watcher_block_height",
    help: "Block height of the block watcher",
    labelNames: ["chain_id"],
  });
  static blockWatcherReorgCount = new client.Counter({
    name: "block_watcher_reorg_count",
    help: "Total number of reorgs",
    labelNames: ["chain_id"],
  });
  static blockWatcherBlockTime = new client.Gauge({
    name: "block_watcher_block_time",
    help: "Time since last block",
    labelNames: ["chain_id"],
  });
  static blockWatcherNumEventsProcessed = new client.Counter({
    name: "block_watcher_num_events_processed",
    help: "Total number of events processed",
    labelNames: ["chain_id"],
  });
  static newOwnerCount = new client.Counter({
    name: "add_contract_new_contract_count",
    help: "Total number of new contracts added",
    labelNames: ["chain_id"],
  });
  static addContractSingleOrderCount = new client.Counter({
    name: "add_contract_single_order_count",
    help: "Total number of single orders added",
    labelNames: ["chain_id"],
  });
  static addContractMerkleRootSetCount = new client.Counter({
    name: "add_contract_merkle_root_set_count",
    help: "Total number of merkle root sets added",
    labelNames: ["chain_id"],
  });
  static addNewOwnerErrorCount = new client.Counter({
    name: "add_contract_error_count",
    help: "Total number of errors adding contracts",
    labelNames: ["chain_id", "function"],
  });
  static addContractRunDuration = new client.Histogram({
    name: "add_contract_run_duration",
    help: "Duration of add contract run",
    labelNames: ["chain_id"],
  });
  static processBlockDuration = new client.Histogram({
    name: "chain_context_process_block_duration",
    help: "Duration of chain context process block",
    labelNames: ["chain_id"],
  });
  static ownersPopulation = new client.Gauge({
    name: "watch_tower_num_owners",
    help: "Number of owners",
    labelNames: ["chain_id"],
  });
  static orderBookOrdersPlaced = new client.Counter({
    name: "orderbook_orders_placed",
    help: "Total number of discrete orders placed into the orderbook",
    labelNames: ["chain_id"],
  });
  static orderBookApiErrors = new client.Counter({
    name: "orderbook_api_errors",
    help: "Total number of errors from the orderbook API",
    labelNames: ["chain_id", "status", "error"],
  });
  static pollingOnChainChecks = new client.Counter({
    name: "polling_onchain_checks",
    help: "Total number of on-chain hint checks",
    labelNames: ["chain_id"],
  });
  static pollingOnChainTimer = new client.Histogram({
    name: "polling_onchain_timer",
    help: "Duration of on-chain hint checks",
    labelNames: ["chain_id"],
  });
  static pollingChecks = new client.Counter({
    name: "polling_checks",
    help: "Total number of polling checks",
    labelNames: ["chain_id"],
  });
  static pollingUnexpectedErrors = new client.Counter({
    name: "polling_unexpected_errors",
    help: "Total number of unexpected polling errors",
    labelNames: ["chain_id"],
  });
}
