import client from "prom-client";

const blockHeight = new client.Gauge({
  name: "watch_tower_block_height",
  help: "Block height of the block watcher",
  labelNames: ["chain_id"],
});

const reorgDepth = new client.Gauge({
  name: "watch_tower_reorg_depth",
  help: "Depth of the current reorg",
  labelNames: ["chain_id"],
});

const blockTime = new client.Gauge({
  name: "watch_tower_block_time_seconds",
  help: "Time since last block",
  labelNames: ["chain_id"],
});

const eventsProcessedTotal = new client.Counter({
  name: "watch_tower_events_processed_total",
  help: "Total number of events processed",
  labelNames: ["chain_id"],
});

const reorgsTotal = new client.Counter({
  name: "watch_tower_reorg_total",
  help: "Total number of reorgs",
  labelNames: ["chain_id"],
});

const newContractsTotal = new client.Counter({
  name: "watch_tower_new_contracts_total",
  help: "Total number of new contracts",
  labelNames: ["chain_id"],
});

const singleOrdersTotal = new client.Counter({
  name: "watch_tower_single_orders_total",
  help: "Total number of single orders processed",
  labelNames: ["chain_id"],
});

const merkleRootTotal = new client.Counter({
  name: "watch_tower_merkle_roots_total",
  help: "Total number of merkle roots processed",
  labelNames: ["chain_id"],
});

const addContractsErrorsTotal = new client.Counter({
  name: "watch_tower_add_contracts_errors_total",
  help: "Total number of add contracts errors",
  labelNames: ["chain_id", "function"],
});

const addContractsRunDurationSeconds = new client.Histogram({
  name: "watch_tower_add_contracts_run_duration_seconds",
  help: "Duration of add contracts run",
  labelNames: ["chain_id"],
});

const processBlockDurationSeconds = new client.Histogram({
  name: "watch_tower_process_block_duration_seconds",
  help: "Duration of process block",
  labelNames: ["chain_id"],
});

const totalActiveOwners = new client.Gauge({
  name: "watch_tower_active_owners_total",
  help: "Total number of owners with active orders",
  labelNames: ["chain_id"],
});

const totalActiveOrders = new client.Gauge({
  name: "watch_tower_active_orders_total",
  help: "Total number of active orders",
  labelNames: ["chain_id"],
});

const totalOrderBookDiscreteOrders = new client.Counter({
  name: "watch_tower_orderbook_discrete_orders_total",
  help: "Total number of discrete orders posted to the orderbook",
  labelNames: ["chain_id", "handler", "owner", "id"],
});

const totalOrderBookErrors = new client.Counter({
  name: "watch_tower_orderbook_errors_total",
  help: "Total number of errors when interacting with the orderbook",
  labelNames: ["chain_id", "handler", "owner", "id", "status", "error"],
});

const totalPollingRuns = new client.Counter({
  name: "watch_tower_polling_runs_total",
  help: "Total number of polling runs",
  labelNames: ["chain_id", "handler", "owner", "id"],
});

const totalPollingOnChainChecks = new client.Counter({
  name: "watch_tower_polling_onchain_checks_total",
  help: "Total number of on-chain hint checks",
  labelNames: ["chain_id", "handler", "owner", "id"],
});

const pollingOnChainDurationSeconds = new client.Histogram({
  name: "watch_tower_polling_onchain_duration_seconds",
  help: "Duration of on-chain hint checks",
  labelNames: ["chain_id", "handler", "owner", "id"],
});

const totalPollingUnexpectedErrors = new client.Counter({
  name: "watch_tower_polling_unexpected_errors_total",
  help: "Total number of unexpected polling errors",
  labelNames: ["chain_id", "handler", "owner", "id"],
});

export {
  blockHeight,
  reorgDepth,
  blockTime,
  eventsProcessedTotal,
  reorgsTotal,
  newContractsTotal,
  singleOrdersTotal,
  merkleRootTotal,
  addContractsErrorsTotal,
  addContractsRunDurationSeconds,
  processBlockDurationSeconds,
  totalActiveOwners,
  totalActiveOrders,
  totalOrderBookDiscreteOrders,
  totalOrderBookErrors,
  totalPollingRuns,
  totalPollingOnChainChecks,
  pollingOnChainDurationSeconds,
  totalPollingUnexpectedErrors,
};
