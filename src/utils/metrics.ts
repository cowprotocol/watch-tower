import client from "prom-client";

export interface MeasureTimeParams<T, U> {
  action: () => T;
  labelValues: string[];
  durationMetric: client.Histogram;
  totalRunsMetric: client.Counter;
  errorHandler?: (err: any) => U;
  errorMetric?: client.Counter;
}

export function measureTime<T, U>({
  action,
  labelValues,
  durationMetric,
  totalRunsMetric,
  errorHandler,
  errorMetric,
}: MeasureTimeParams<T, U>): T | U {
  const timer = durationMetric.labels(...labelValues).startTimer();
  let result: T | U;
  try {
    result = action();
  } catch (err) {
    if (errorHandler === undefined) {
      throw err;
    }

    if (errorMetric === undefined) {
      throw new Error("errorMetric must be defined if errorHandler is defined");
    }

    errorMetric.labels(...labelValues).inc();
    result = errorHandler(err);
  } finally {
    timer();
  }
  totalRunsMetric.labels(...labelValues).inc();
  return result;
}

export const blockHeight = new client.Gauge({
  name: "watch_tower_block_height",
  help: "Block height of the block watcher",
  labelNames: ["chain_id"],
});

export const reorgDepth = new client.Gauge({
  name: "watch_tower_latest_reorg_depth",
  help: "Depth of the most recent reorg",
  labelNames: ["chain_id"],
});

export const blockProducingRate = new client.Gauge({
  name: "watch_tower_block_production_seconds",
  help: "Time since last block",
  labelNames: ["chain_id"],
});

export const eventsProcessedTotal = new client.Counter({
  name: "watch_tower_order_mutation_events_total",
  help: "Total number of events for conditional order creation or Merkle root update (ConditionalOrderCreated and MerkleRootSet respectively)",
  labelNames: ["chain_id"],
});

export const reorgsTotal = new client.Counter({
  name: "watch_tower_reorg_total",
  help: "Total number of reorgs",
  labelNames: ["chain_id"],
});

export const ownersTotal = new client.Counter({
  name: "conditional_order_owners_total",
  help: "Total number of owner contracts",
  labelNames: ["chain_id"],
});

export const singleOrdersTotal = new client.Counter({
  name: "watch_tower_single_orders_total",
  help: "Total number of single orders processed",
  labelNames: ["chain_id"],
});

export const merkleRootTotal = new client.Counter({
  name: "watch_tower_merkle_roots_total",
  help: "Total number of merkle roots processed",
  labelNames: ["chain_id"],
});

export const addContractRunsTotal = new client.Counter({
  name: "watch_tower_add_contract_runs_total",
  help: "Total number of add contract runs",
  labelNames: ["chain_id"],
});

export const addContractsErrorsTotal = new client.Counter({
  name: "watch_tower_add_contracts_errors_total",
  help: "Total number of add contracts errors",
  labelNames: ["chain_id", "function"],
});

export const addContractsRunDurationSeconds = new client.Histogram({
  name: "watch_tower_add_contracts_run_duration_seconds",
  help: "Duration of add contracts run",
  labelNames: ["chain_id"],
});

export const processBlockDurationSeconds = new client.Histogram({
  name: "watch_tower_process_block_duration_seconds",
  help: "Duration of process block",
  labelNames: ["chain_id"],
});

export const activeOwnersTotal = new client.Gauge({
  name: "watch_tower_active_owners_total",
  help: "Total number of owners with active orders",
  labelNames: ["chain_id"],
});

export const activeOrdersTotal = new client.Gauge({
  name: "watch_tower_active_orders_total",
  help: "Total number of active orders",
  labelNames: ["chain_id"],
});

export const orderBookDiscreteOrdersTotal = new client.Counter({
  name: "watch_tower_orderbook_discrete_orders_total",
  help: "Total number of discrete orders posted to the orderbook",
  labelNames: ["chain_id", "handler", "owner", "id"],
});

export const orderBookErrorsTotal = new client.Counter({
  name: "watch_tower_orderbook_errors_total",
  help: "Total number of errors when interacting with the orderbook",
  labelNames: ["chain_id", "handler", "owner", "id", "status", "error"],
});

export const pollingRunsTotal = new client.Counter({
  name: "watch_tower_polling_runs_total",
  help: "Total number of polling runs",
  labelNames: ["chain_id", "handler", "owner", "id"],
});

export const pollingOnChainChecksTotal = new client.Counter({
  name: "watch_tower_polling_onchain_checks_total",
  help: "Total number of on-chain hint checks",
  labelNames: ["chain_id", "handler", "owner", "id"],
});

export const pollingOnChainDurationSeconds = new client.Histogram({
  name: "watch_tower_polling_onchain_duration_seconds",
  help: "Duration of on-chain hint checks",
  labelNames: ["chain_id", "handler", "owner", "id"],
});

export const pollingOnChainInvalidInterfacesTotal = new client.Counter({
  name: "watch_tower_polling_onchain_invalid_interface_total",
  help: "Total number of invalid on-chain hint interface",
  labelNames: ["chain_id", "handler", "owner", "id"],
});

export const pollingOnChainEthersErrorsTotal = new client.Counter({
  name: "watch_tower_polling_onchain_ethers_errors_total",
  help: "Total number of ethers on-chain hint errors",
  labelNames: ["chain_id", "handler", "owner", "id"],
});

export const pollingUnexpectedErrorsTotal = new client.Counter({
  name: "watch_tower_polling_unexpected_errors_total",
  help: "Total number of unexpected polling errors",
  labelNames: ["chain_id", "handler", "owner", "id"],
});
