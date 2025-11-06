import {
  ApiBaseUrls,
  OrderBookApi,
  setGlobalAdapter,
  SupportedChainId,
} from "@cowprotocol/cow-sdk";
import { EthersV5Adapter } from "@cowprotocol/sdk-ethers-v5-adapter";
import { ethers, providers } from "ethers";
import { DBService } from ".";
import { processNewOrderEvent } from "../domain/events";
import { checkForAndPlaceOrder } from "../domain/polling";
import { policy } from "../domain/polling/filtering";
import {
  ComposableCoW,
  ConditionalOrderCreatedEvent,
  ContextOptions,
  Multicall3,
  Multicall3__factory,
  Registry,
  RegistryBlock,
} from "../types";
import {
  composableCowContract,
  getLogger,
  isRunningInKubernetesPod,
  LoggerWithMethods,
  metrics,
} from "../utils";

const WATCHDOG_FREQUENCY_SECS = 5; // 5 seconds
const WATCHDOG_TIMEOUT_DEFAULT_SECS = 30;

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const PAGE_SIZE_DEFAULT = 5000;

const SDK_BACKOFF_NUM_OF_ATTEMPTS = 5;

enum ChainSync {
  /** The chain is currently in the warm-up phase, synchronising from contract genesis or lastBlockProcessed */
  SYNCING = "SYNCING",
  /** The chain is in sync with the latest block */
  IN_SYNC = "IN_SYNC",
  /** The chain is in an unknown state based on duration of time since a block was processed */
  UNKNOWN = "UNKNOWN",
}

type Chains = { [chainId: number]: ChainContext };

export interface ChainStatus {
  sync: ChainSync;
  chainId: SupportedChainId;
  lastProcessedBlock: RegistryBlock | null;
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

export interface FilterPolicyConfig {
  baseUrl: string;
  // authToken: string; // TODO: Implement authToken
}

/**
 * The chain context handles watching a single chain for new conditional orders
 * and executing them.
 */
export class ChainContext {
  readonly deploymentBlock: number;
  readonly pageSize: number;
  readonly dryRun: boolean;
  readonly watchdogTimeout: number;
  readonly addresses?: string[];
  readonly processEveryNumBlocks: number;

  private sync: ChainSync;
  static chains: Chains = {};

  provider: providers.Provider;
  chainId: SupportedChainId;
  registry: Registry;
  orderBookApi: OrderBookApi;
  filterPolicy: policy.FilterPolicy | undefined;
  contract: ComposableCoW;
  multicall: Multicall3;

  protected constructor(
    options: ContextOptions,
    provider: providers.Provider,
    chainId: SupportedChainId,
    registry: Registry
  ) {
    const {
      deploymentBlock,
      pageSize,
      dryRun,
      watchdogTimeout,
      owners,
      orderBookApi: orderBookApiUrl,
      filterPolicy,
    } = options;

    this.sync = ChainSync.SYNCING;
    this.deploymentBlock = deploymentBlock;
    this.pageSize = pageSize ?? PAGE_SIZE_DEFAULT;
    this.dryRun = dryRun;
    this.processEveryNumBlocks = options.processEveryNumBlocks ?? 1;
    this.watchdogTimeout = watchdogTimeout ?? WATCHDOG_TIMEOUT_DEFAULT_SECS;
    this.addresses = owners;

    this.provider = provider;
    this.chainId = chainId;
    this.registry = registry;

    const baseUrls = orderBookApiUrl
      ? ({
          [this.chainId]: orderBookApiUrl,
        } as ApiBaseUrls) // FIXME: do not do this casting once this is fixed https://github.com/cowprotocol/cow-sdk/issues/176
      : undefined;

    this.orderBookApi = new OrderBookApi({
      chainId,
      baseUrls,
      backoffOpts: {
        numOfAttempts: SDK_BACKOFF_NUM_OF_ATTEMPTS,
      },
    });

    this.filterPolicy = new policy.FilterPolicy(filterPolicy);
    this.contract = composableCowContract(this.provider, this.chainId);
    this.multicall = Multicall3__factory.connect(MULTICALL3, this.provider);
  }

  /**
   * Initialize a chain context.
   *
   * @param options as parsed by commander from the command line arguments.
   * @param storage the db singleton that provides persistence.
   * @returns A chain context that is monitoring for orders on the chain.
   */
  public static async init(
    options: ContextOptions,
    storage: DBService
  ): Promise<ChainContext> {
    const { rpc, deploymentBlock } = options;

    const provider = getProvider(rpc.toLowerCase());
    const chainId = (await provider.getNetwork()).chainId;

    setGlobalAdapter(new EthersV5Adapter({ provider: provider }));

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
   * @param oneShot if true, only warm up the chain watcher and return
   * @returns the run promises for what needs to be watched
   */
  public async warmUp(oneShot?: boolean) {
    const { provider, chainId, processEveryNumBlocks } = this;
    const log = getLogger({ name: "warmUp", chainId });
    let { lastProcessedBlock } = this.registry;
    const { pageSize } = this;

    // Set the sync status metric (Syncing)
    metrics.syncStatus.labels(chainId.toString()).set(0);

    // Set the block height metric
    metrics.blockHeight
      .labels(chainId.toString())
      .set(lastProcessedBlock?.number ?? 0);

    // Start watching from (not including) the last processed block (if any)
    let fromBlock = lastProcessedBlock
      ? lastProcessedBlock.number + 1
      : this.deploymentBlock;

    let currentBlock = await provider.getBlock("latest");
    metrics.blockHeightLatest
      .labels(chainId.toString())
      .set(currentBlock.number);

    let printSyncInfo = true; // Print sync info only once
    let toBlock: "latest" | number = 0;
    do {
      do {
        toBlock = !pageSize ? "latest" : fromBlock + (pageSize - 1);
        if (typeof toBlock === "number" && toBlock > currentBlock.number) {
          // refresh the current block
          currentBlock = await provider.getBlock("latest");
          metrics.blockHeightLatest
            .labels(chainId.toString())
            .set(currentBlock.number);
          toBlock =
            toBlock > currentBlock.number ? currentBlock.number : toBlock;

          // This happens when the watch-tower has restarted and the last processed block is
          // the current block. Therefore the `fromBlock` is the current block + 1, which is
          // greater than the current block number. In this case, we are in sync.
          if (fromBlock > currentBlock.number) {
            this.sync = ChainSync.IN_SYNC;
            break;
          }

          log.debug(
            `Reaching tip of chain, current block number: ${currentBlock.number}`
          );
        }

        if (printSyncInfo && typeof toBlock === "number") {
          printSyncInfo = false;
          log.info(
            `🔄 Start sync with from block ${fromBlock} to ${toBlock}. Pending ${
              toBlock - fromBlock
            } blocks (~${Math.ceil(
              (toBlock - fromBlock) / pageSize
            )} pages, processing every ${
              processEveryNumBlocks > 1
                ? processEveryNumBlocks + " blocks"
                : "block"
            })`
          );
        }

        log.debug(
          `Processing events from block ${fromBlock} to block ${toBlock}`
        );

        const events = await pollContractForEvents(fromBlock, toBlock, this);

        if (events.length > 0) {
          log.debug(`Found ${events.length} events`);
        }

        // Get relevant block numbers to process (the ones with relevant events)
        const eventsByBlock = events.reduce<
          Record<number, ConditionalOrderCreatedEvent[]>
        >((acc, event) => {
          const events = acc[event.blockNumber];
          if (events) {
            events.push(event);
          } else {
            acc[event.blockNumber] = [event];
          }

          return acc;
        }, {});

        // Process blocks in order
        for (const blockNumberKey of Object.keys(eventsByBlock).sort()) {
          const blockNumber = Number(blockNumberKey);
          await processBlockAndPersist({
            context: this,
            blockNumber,
            events: eventsByBlock[blockNumber],
            currentBlock,
            log,
            provider,
          });
        }

        // Persist "toBlock" as the last block (even if there's no events, we are caught up until this block)
        lastProcessedBlock = await persistLastProcessedBlock({
          context: this,
          block: await provider.getBlock(toBlock),
          log,
        });

        // only possible string value for toBlock is 'latest'
        if (typeof toBlock === "number") {
          fromBlock = toBlock + 1;
        }
      } while (toBlock !== "latest" && toBlock !== currentBlock.number);

      // It may have taken some time to process the blocks, so refresh the current block number
      // and check if we are in sync
      currentBlock = await provider.getBlock("latest");
      metrics.blockHeightLatest
        .labels(chainId.toString())
        .set(currentBlock.number);

      // If we are in sync, let it be known
      const lastProcessedBlockNumber = lastProcessedBlock?.number || 0;
      if (currentBlock.number === lastProcessedBlockNumber) {
        this.sync = ChainSync.IN_SYNC;
      } else {
        // Otherwise, we need to keep processing blocks
        fromBlock = lastProcessedBlockNumber + 1;
      }
    } while (this.sync === ChainSync.SYNCING);

    metrics.syncStatus.labels(chainId.toString()).set(1);
    log.info(
      `☀️ ${
        oneShot ? "Chain watcher is in sync" : "Chain watcher is warmed up"
      }`
    );
    log.debug(`Last processed block: ${JSON.stringify(lastProcessedBlock)}`);

    // If one-shot, return
    if (oneShot) {
      return;
    }

    // Otherwise, run the block watcher
    return await this.subscribeToNewBlocks(currentBlock);
  }

  /**
   * Run the block watcher for the chain. As new blocks come in:
   * 1. Check if there are any `ConditionalOrderCreated` events, and index these.
   * 2. Check if any orders want to create discrete orders.
   */
  private async subscribeToNewBlocks(lastProcessedBlock: providers.Block) {
    const { provider, registry, chainId, watchdogTimeout } = this;
    const loggerName = "subscribeToNewBlocks";
    let log = getLogger({ name: loggerName, chainId });
    // Watch for new blocks
    log.info(`👀 Start block watcher`);
    log.debug(`Watchdog timeout: ${watchdogTimeout} seconds`);
    let lastBlockReceived = lastProcessedBlock;
    provider.on("block", async (blockNumber: number) => {
      metrics.blockHeightLatest.labels(chainId.toString()).set(blockNumber);

      try {
        log = getLogger({
          name: loggerName,
          chainId,
          blockNumber,
        });
        log.debug("New block received");

        const block = await provider.getBlock(blockNumber);

        // Set the block time metric
        const _blockTime = block.timestamp - lastBlockReceived.timestamp;
        metrics.blockProducingRate.labels(chainId.toString()).set(_blockTime);

        if (
          blockNumber <= lastBlockReceived.number &&
          block.hash !== lastBlockReceived.hash
        ) {
          // This is a re-org, so process the block again
          metrics.reorgsTotal.labels(chainId.toString()).inc();
          log.info(`Re-org detected, re-processing block ${blockNumber}`);
          metrics.reorgDepth
            .labels(chainId.toString())
            .set(lastBlockReceived.number - blockNumber + 1);
        }
        lastBlockReceived = block;

        const events = await pollContractForEvents(
          blockNumber,
          blockNumber,
          this
        );

        await processBlockAndPersist({
          context: this,
          block,
          blockNumber,
          events,
          log,
          provider,
        });
      } catch (error) {
        log.error(
          `Error in pollContractForEvents for block ${blockNumber}`,
          error
        );
      }
    });

    // We run a watchdog to check if we are receiving blocks. This determines if
    // the chain is stuck or not issuing blocks. If running within a kubernetes
    // pod, we don't exit, but we do log an error and set the sync status to unknown.
    while (true) {
      // sleep for 5 seconds
      await asyncSleep(WATCHDOG_FREQUENCY_SECS * 1000);
      const now = Math.floor(new Date().getTime() / 1000);
      const timeElapsed = now - lastBlockReceived.timestamp;

      log.debug(`Time since last block processed: ${timeElapsed}s`);

      // If we haven't received a block within `watchdogTimeout` seconds, either signal
      // an error or exit if not running in a kubernetes pod
      if (timeElapsed >= watchdogTimeout) {
        log.error(
          `Chain watcher last processed a block ${timeElapsed}s ago (${watchdogTimeout}s timeout configured). Check the RPC.`
        );
        if (isRunningInKubernetesPod()) {
          this.sync = ChainSync.UNKNOWN;
          continue;
        }

        // We need to handle our own exit here as the process is not running in a kubernetes pod
        await registry.storage.close();
        process.exit(1);
      }
    }
  }

  /** Get the specific chain's health */
  get health(): ChainHealth {
    const { sync, chainId } = this;
    return {
      sync,
      chainId,
      lastProcessedBlock: this.registry.lastProcessedBlock,
      isHealthy: this.isHealthy(),
    };
  }

  /** Determine if the specific chain is healthy */
  private isHealthy(): boolean {
    return this.sync === ChainSync.IN_SYNC;
  }

  /** Get the health status of all the chains, and the overall status */
  static get health(): ChainWatcherHealth {
    const chains = Object.values(ChainContext.chains).reduce(
      (acc, chain) => {
        const { chainId } = chain;
        acc.chains[Number(chainId.toString())] = chain.health;
        acc.overallHealth = acc.overallHealth && chain.isHealthy();
        return acc;
      },
      { chains: {}, overallHealth: true } as ChainWatcherHealth
    );

    return chains;
  }

  /** Determine if all chains are healthy */
  static isHealthy(): boolean {
    return ChainContext.health.overallHealth;
  }
}

/**
 * Process events in a block.
 * @param context of the chain who's block is being processed
 * @param block from which the events were emitted
 * @param events an array of conditional order created events
 * @param blockNumberOverride to override the block number when polling the SDK
 * @param blockTimestampOverride  to override the block timestamp when polling the SDK
 */
async function processBlockEvent(
  context: ChainContext,
  block: providers.Block,
  events: ConditionalOrderCreatedEvent[],
  blockNumberOverride?: number,
  blockTimestampOverride?: number
) {
  const { provider, chainId, processEveryNumBlocks } = context;
  const timer = metrics.processBlockDurationSeconds
    .labels(context.chainId.toString())
    .startTimer();

  const log = getLogger({
    name: "processBlockEvent",
    chainId,
    blockNumber: block.number,
  });

  // Transaction watcher for adding new contracts
  let hasErrors = false;
  for (const event of events) {
    const receipt = await provider.getTransactionReceipt(event.transactionHash);

    if (receipt) {
      // run action
      log.debug(`Process new order event of TX ${event.transactionHash}`);
      const result = await processNewOrderEvent(context, event)
        .then(() => true)
        .catch((e) => {
          hasErrors = true;
          log.error(
            `Error processing new order event of TX ${event.transactionHash}:`,
            e
          );
          return false;
        });
      log.info(
        `Result of processing new order event of TX ${
          event.transactionHash
        }: ${_formatResult(result)}`
      );
      metrics.eventsProcessedTotal.labels(chainId.toString()).inc();
    }
  }

  // Decide if we should process this block
  const shouldProcessBlock = block.number % processEveryNumBlocks === 0;

  // Check programmatic  orders and place orders if necessary
  if (shouldProcessBlock) {
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
      `Result of "checkForAndPlaceOrder" action for block ${
        block.number
      }: ${_formatResult(result)}`
    );
  }

  timer();

  if (hasErrors) {
    throw new Error("Errors found in processing block");
  }
}

async function persistLastProcessedBlock(params: {
  context: ChainContext;
  block: ethers.providers.Block;
  log: LoggerWithMethods;
}) {
  const { context, block, log } = params;

  // Set the last processed block to the current block number
  context.registry.lastProcessedBlock = blockToRegistryBlock(block);

  // Save the registry
  await context.registry.write();
  log.debug(`Block has been processed`);

  // Set the block metrics
  const chain = context.chainId.toString();
  metrics.blockTimestamp.labels(chain).set(block.timestamp);
  metrics.blockHeight.labels(chain).set(block.number);

  return context.registry.lastProcessedBlock;
}

async function processBlockAndPersist(params: {
  context: ChainContext;
  block?: providers.Block;
  blockNumber: number;
  events: ConditionalOrderCreatedEvent[];
  currentBlock?: providers.Block;
  log: LoggerWithMethods;
  provider: ethers.providers.Provider;
}) {
  const { context, block, blockNumber, events, currentBlock, log, provider } =
    params;

  // Accept optional block object, in case it was already fetched
  const _block = block || (await provider.getBlock(blockNumber));

  try {
    await processBlockEvent(
      context,
      _block,
      events,
      currentBlock?.number,
      currentBlock?.timestamp
    );
  } catch (err) {
    log.error(`Error processing block ${_block.number}`, err);
  } finally {
    return persistLastProcessedBlock({ context, block: _block, log });
  }
}

async function pollContractForEvents(
  fromBlock: number,
  toBlock: number | "latest",
  context: ChainContext
): Promise<ConditionalOrderCreatedEvent[]> {
  const { provider, chainId, addresses } = context;
  const composableCow = composableCowContract(provider, chainId);
  const eventName = "ConditionalOrderCreated(address,(address,bytes32,bytes))";
  const topic = ethers.utils.id(eventName);

  const logs = await provider.getLogs({
    fromBlock,
    toBlock,
    topics: [topic],
  });

  return logs.reduce<ConditionalOrderCreatedEvent[]>((acc, event) => {
    try {
      const decoded = composableCow.interface.decodeEventLog(
        topic,
        event.data,
        event.topics
      ) as unknown as ConditionalOrderCreatedEvent;

      if (!addresses || addresses.includes(decoded.args.owner)) {
        acc.push({
          ...decoded,
          ...event,
        });
      }
    } catch {
      // Ignore errors and do not add to the accumulator
    }
    return acc;
  }, []);
}

function _formatResult(result: boolean) {
  return result ? "✅" : "❌";
}

function getProvider(rpcUrl: string): providers.Provider {
  const log = getLogger({ name: "getProvider", args: [rpcUrl] });

  // if the rpcUrl is a websocket url, use the WebSocketProvider
  if (rpcUrl.startsWith("ws")) {
    log.debug("Instantiating WS");
    return new providers.WebSocketProvider(rpcUrl);
  }

  log.debug("Instantiating HTTP");

  // otherwise, use the JsonRpcProvider
  return new providers.JsonRpcProvider(rpcUrl);
}

async function asyncSleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function blockToRegistryBlock(block: ethers.providers.Block): RegistryBlock {
  return {
    number: block.number,
    timestamp: block.timestamp,
    hash: block.hash,
  };
}
