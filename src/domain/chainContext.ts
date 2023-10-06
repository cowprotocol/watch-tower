import {
  SingularRunOptions,
  Registry,
  ReplayPlan,
  ConditionalOrderCreatedEvent,
  Multicall3,
  ComposableCoW,
  Multicall3__factory,
} from "../types";
import { SupportedChainId, OrderBookApi } from "@cowprotocol/cow-sdk";
import { addContract } from "./addContract";
import { checkForAndPlaceOrder } from "./checkForAndPlaceOrder";
import { ethers } from "ethers";
import { composableCowContract, DBService, getLogger } from "../utils";
import {
  blockHeight,
  blockTime,
  eventsProcessedTotal,
  processBlockDurationSeconds,
  reorgDepth,
  reorgsTotal,
} from "../utils/metrics";

const WATCHDOG_FREQUENCY = 5 * 1000; // 5 seconds

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

enum ChainSync {
  SYNCED = "SYNCED",
  SYNCING = "SYNCING",
}

type Chains = { [chainId: number]: ChainContext };

export interface ChainStatus {
  sync: ChainSync;
  chainId: SupportedChainId;
  lastProcessedBlock: number;
}

export interface ChainHealth extends ChainStatus {
  isHealthy: boolean;
}

export interface ChainWatcherHealth {
  overallHealth: boolean;
  chains: {
    [chainId: number]: ChainHealth;
  };
}

/**
 * The chain context handles watching a single chain for new conditional orders
 * and executing them.
 */
export class ChainContext {
  readonly deploymentBlock: number;
  readonly pageSize: number;
  readonly dryRun: boolean;
  private sync: ChainSync = ChainSync.SYNCING;
  static chains: Chains = {};

  provider: ethers.providers.Provider;
  chainId: SupportedChainId;
  registry: Registry;
  orderBook: OrderBookApi;
  contract: ComposableCoW;
  multicall: Multicall3;

  protected constructor(
    options: SingularRunOptions,
    provider: ethers.providers.Provider,
    chainId: SupportedChainId,
    registry: Registry
  ) {
    const { deploymentBlock, pageSize, dryRun } = options;
    this.deploymentBlock = deploymentBlock;
    this.pageSize = pageSize;
    this.dryRun = dryRun;

    this.provider = provider;
    this.chainId = chainId;
    this.registry = registry;
    this.orderBook = new OrderBookApi({ chainId: this.chainId });

    this.contract = composableCowContract(this.provider, this.chainId);
    this.multicall = Multicall3__factory.connect(MULTICALL3, this.provider);
  }

  /**
   * Initialise a chain context.
   * @param options as parsed by commander from the command line arguments.
   * @param storage the db singleton that provides persistence.
   * @returns A chain context that is monitoring for orders on the chain.
   */
  public static async init(
    options: SingularRunOptions,
    storage: DBService
  ): Promise<ChainContext> {
    const { rpc, deploymentBlock } = options;

    const provider = new ethers.providers.JsonRpcProvider(rpc);
    const chainId = (await provider.getNetwork()).chainId;

    const registry = await Registry.load(
      storage,
      chainId.toString(),
      deploymentBlock
    );

    // Save the context to the static map to be used by the API
    const context = new ChainContext(options, provider, chainId, registry);
    ChainContext.chains[chainId] = context;

    return context;
  }

  /**
   * Warm up the chain watcher by fetching the latest block number and
   * checking if the chain is in sync.
   * @param watchdogTimeout the timeout for the watchdog
   * @param oneShot if true, only warm up the chain watcher and return
   * @returns the run promises for what needs to be watched
   */
  public async warmUp(watchdogTimeout: number, oneShot?: boolean) {
    const { provider, chainId } = this;
    const log = getLogger(`chainContext:warmUp:${chainId}`);
    const { lastProcessedBlock } = this.registry;
    const { pageSize } = this;

    // Set the block height metric
    blockHeight.labels(chainId.toString()).set(lastProcessedBlock ?? 0);

    // Start watching from (not including) the last processed block (if any)
    let fromBlock = lastProcessedBlock
      ? lastProcessedBlock + 1
      : this.deploymentBlock;
    let currentBlockNumber = await provider.getBlockNumber();

    let printSyncInfo = true; // Print sync info only once
    let plan: ReplayPlan = {};
    let toBlock: "latest" | number = 0;
    do {
      do {
        toBlock = !pageSize ? "latest" : fromBlock + (pageSize - 1);
        if (typeof toBlock === "number" && toBlock > currentBlockNumber) {
          // refresh the current block number
          currentBlockNumber = await provider.getBlockNumber();
          toBlock = toBlock > currentBlockNumber ? currentBlockNumber : toBlock;

          log.debug(
            `Reaching tip of chain, current block number: ${currentBlockNumber}`
          );
        }

        if (printSyncInfo && typeof toBlock === "number") {
          printSyncInfo = false;
          log.info(
            `🔄 Start sync with from block ${fromBlock} to ${toBlock}. Pending ${
              toBlock - fromBlock
            } blocks (~${Math.ceil((toBlock - fromBlock) / pageSize)} pages)`
          );
        }

        log.debug(
          `Processing events from block ${fromBlock} to block ${toBlock}`
        );

        const events = await pollContractForEvents(fromBlock, toBlock, this);

        if (events.length > 0) {
          log.debug(`Found ${events.length} events`);
        }

        // process the events
        for (const event of events) {
          if (plan[event.blockNumber] === undefined) {
            plan[event.blockNumber] = new Set();
          }

          plan[event.blockNumber].add(event);
        }

        // only possible string value for toBlock is 'latest'
        if (typeof toBlock === "number") {
          fromBlock = toBlock + 1;
        }
      } while (toBlock !== "latest" && toBlock !== currentBlockNumber);

      const block = await provider.getBlock(currentBlockNumber);

      // Replay only the blocks that had some events.
      for (const [blockNumber, events] of Object.entries(plan)) {
        log.debug(`Processing block ${blockNumber}`);
        try {
          await processBlock(
            this,
            Number(blockNumber),
            events,
            block.number,
            block.timestamp
          );

          // Set the last processed block to this iteration's block number
          this.registry.lastProcessedBlock = Number(blockNumber);
          await this.registry.write();

          // Set the block height metric
          blockHeight.labels(chainId.toString()).set(Number(blockNumber));
        } catch (err) {
          log.error(`Error processing block ${blockNumber}`, err);
        }

        log.debug(`Block ${blockNumber} has been processed`);
      }

      // Set the last processed block to the current block number
      this.registry.lastProcessedBlock = currentBlockNumber;

      // Save the registry
      await this.registry.write();

      // It may have taken some time to process the blocks, so refresh the current block number
      // and check if we are in sync
      currentBlockNumber = await provider.getBlockNumber();

      // If we are in sync, let it be known
      if (currentBlockNumber === this.registry.lastProcessedBlock) {
        this.sync = ChainSync.SYNCED;
      } else {
        // Otherwise, we need to keep processing blocks
        fromBlock = this.registry.lastProcessedBlock + 1;
        plan = {};
      }
    } while (this.sync === ChainSync.SYNCING);

    log.info(
      `💚 ${
        oneShot ? "Chain watcher is in sync" : "Chain watcher is warmed up"
      }`
    );
    log.debug(`Last processed block: ${this.registry.lastProcessedBlock}`);

    // If one-shot, return
    if (oneShot) {
      return;
    }

    // Otherwise, run the block watcher
    return await this.runBlockWatcher(watchdogTimeout);
  }

  /**
   * Run the block watcher for the chain. As new blocks come in:
   * 1. Check if there are any `ConditionalOrderCreated` events, and index these.
   * 2. Check if any orders want to create discrete orders.
   */
  private async runBlockWatcher(watchdogTimeout: number) {
    const { provider, registry, chainId } = this;
    const log = getLogger(`chainContext:runBlockWatcher:${chainId}`);
    // Watch for new blocks
    log.info(`👀 Start block watcher`);
    log.debug(`Watchdog timeout: ${watchdogTimeout} seconds`);
    let lastBlockReceived = 0;
    let timeLastBlockProcessed = new Date().getTime();
    provider.on("block", async (blockNumber: number) => {
      try {
        log.debug(`New block ${blockNumber}`);
        // Set the block time metric
        const now = new Date().getTime();
        const _blockTime = (now - timeLastBlockProcessed) / 1000;
        timeLastBlockProcessed = now;

        // Set the block time metric
        blockTime.labels(chainId.toString()).set(_blockTime);

        if (blockNumber <= lastBlockReceived) {
          // This may be a re-org, so process the block again
          reorgsTotal.labels(chainId.toString()).inc();
          log.info(`Re-org detected, re-processing block ${blockNumber}`);
          reorgDepth
            .labels(chainId.toString())
            .set(lastBlockReceived - blockNumber + 1);
        }
        lastBlockReceived = blockNumber;

        const events = await pollContractForEvents(
          blockNumber,
          blockNumber,
          this
        );

        try {
          await processBlock(this, Number(blockNumber), events);

          // Block height metric
          blockHeight.labels(chainId.toString()).set(Number(blockNumber));
          this.registry.lastProcessedBlock = Number(blockNumber);
        } catch {
          log.error(`Error processing block ${blockNumber}`);
        }

        log.debug(`Block ${blockNumber} has been processed`);
      } catch (error) {
        log.error(
          `Error in pollContractForEvents for block ${blockNumber}`,
          error
        );
      }
    });

    // We run a watchdog to check if we are receiving blocks.
    while (true) {
      // sleep for 5 seconds
      await asyncSleep(WATCHDOG_FREQUENCY);
      const currentTime = new Date().getTime();
      const timeElapsed = currentTime - timeLastBlockProcessed;

      log.debug(`Time since last block processed: ${timeElapsed}ms`);

      // If we haven't received a block in 30 seconds, exit so that the process manager can restart us
      if (timeElapsed >= watchdogTimeout * 1000) {
        log.error(
          `Watchdog timeout (RPC failed, or chain is stuck / not issuing blocks)`
        );
        await registry.storage.close();
        process.exit(1);
      }
    }
  }

  get status(): ChainStatus {
    const { sync, chainId } = this;
    return {
      sync,
      chainId,
      lastProcessedBlock: this.registry.lastProcessedBlock ?? 0,
    };
  }

  get health(): ChainHealth {
    return {
      ...this.status,
      isHealthy: this.isHealthy(),
    };
  }

  private isHealthy(): boolean {
    return this.sync === ChainSync.SYNCED;
  }
}

/**
 * Process events in a block.
 * @param context of the chain who's block is being processed
 * @param blockNumber from which the events were emitted
 * @param events an array of conditional order created events
 * @param blockNumberOverride to override the block number when polling the SDK
 * @param blockTimestampOverride  to override the block timestamp when polling the SDK
 */
async function processBlock(
  context: ChainContext,
  blockNumber: number,
  events: ConditionalOrderCreatedEvent[],
  blockNumberOverride?: number,
  blockTimestampOverride?: number
) {
  const { provider, chainId } = context;
  const timer = processBlockDurationSeconds
    .labels(context.chainId.toString())
    .startTimer();
  const log = getLogger(`chainContext:processBlock:${chainId}:${blockNumber}`);
  const block = await provider.getBlock(blockNumber);

  // Transaction watcher for adding new contracts
  let hasErrors = false;
  for (const event of events) {
    const receipt = await provider.getTransactionReceipt(event.transactionHash);
    if (receipt) {
      // run action
      log.debug(`Running "addContract" action for TX ${event.transactionHash}`);
      const result = await addContract(context, event)
        .then(() => true)
        .catch((e) => {
          hasErrors = true;
          log.error(`Error running "addContract" action for TX:`, e);
          return false;
        });
      log.info(`Result of "addContract": ${_formatResult(result)}`);
      eventsProcessedTotal.labels(chainId.toString()).inc();
    }
  }

  // run action
  const result = await checkForAndPlaceOrder(
    context,
    block,
    blockNumberOverride,
    blockTimestampOverride
  )
    .then(() => true)
    .catch(() => {
      hasErrors = true;
      log.error(`Error running "checkForAndPlaceOrder" action`);
      return false;
    });
  log.debug(
    `Result of "checkForAndPlaceOrder" action for block ${blockNumber}: ${_formatResult(
      result
    )}`
  );

  timer();
  if (hasErrors) {
    throw new Error("Errors found in processing block");
  }
}

function pollContractForEvents(
  fromBlock: number,
  toBlock: number | "latest",
  context: ChainContext
): Promise<ConditionalOrderCreatedEvent[]> {
  const { provider, chainId } = context;
  const composableCow = composableCowContract(provider, chainId);
  const filter = composableCow.filters.ConditionalOrderCreated();
  return composableCow.queryFilter(filter, fromBlock, toBlock);
}

function _formatResult(result: boolean) {
  return result ? "✅" : "❌";
}

async function asyncSleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
