import {
  ApiBaseUrls,
  setGlobalAdapter,
  SupportedChainId,
} from "@cowprotocol/cow-sdk";
import { OrderBookApi } from "@cowprotocol/sdk-order-book";
import { EthersV5Adapter } from "@cowprotocol/sdk-ethers-v5-adapter";
import { ethers, providers } from "ethers";
import { DBService } from ".";
import {
  orderRegistrationTopics,
  processNewOrderEvent,
} from "../domain/events";
import { checkForAndPlaceOrder } from "../domain/polling";
import { policy } from "../domain/polling/filtering";
import {
  ComposableCoW,
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
  withRetry,
  withTimeout,
} from "../utils";

const WATCHDOG_FREQUENCY_SECS = 5; // 5 seconds
export const WATCHDOG_TIMEOUT_DEFAULT_SECS = 60;

/**
 * Upper bound on a single RPC call made from the block processing path, where
 * work is serialised behind the watchdog and must fail fast.
 */
export const RPC_TIMEOUT_MS = 30_000;

/**
 * Upper bound on a single warm-up RPC call.
 *
 * Deliberately far larger than `RPC_TIMEOUT_MS`: warm-up pages over `pageSize`
 * blocks at a time and a cold-start backfill can legitimately take minutes per
 * page on a rate limited RPC. Retrying would not help there - every attempt
 * would hit the same deadline - and the failure exits the whole process. This
 * only exists so a genuinely hung socket eventually errors instead of hanging
 * warm-up forever.
 */
export const WARM_UP_RPC_TIMEOUT_MS = 180_000;

/** Warm-up RPC calls are retried rather than crashing the whole run */
const WARM_UP_RPC_ATTEMPTS = 5;
const WARM_UP_RPC_BASE_DELAY_MS = 1_000;

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const PAGE_SIZE_DEFAULT = 5000;

const SDK_BACKOFF_NUM_OF_ATTEMPTS = 5;
let sdkAdapter: EthersV5Adapter | undefined;

function configureSdkAdapters(provider: providers.Provider): EthersV5Adapter {
  if (!sdkAdapter) {
    sdkAdapter = new EthersV5Adapter({ provider });
    setGlobalAdapter(sdkAdapter);
  }

  return sdkAdapter;
}

export enum ChainSync {
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
  readonly aaveProtectionHandler?: string;
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
      aaveProtectionHandler,
      orderBookApi: orderBookApiUrl,
      filterPolicy,
    } = options;

    this.sync = ChainSync.SYNCING;
    this.deploymentBlock = deploymentBlock;
    this.pageSize = pageSize ?? PAGE_SIZE_DEFAULT;
    this.dryRun = dryRun;
    this.processEveryNumBlocks = options.processEveryNumBlocks ?? 1;
    this.watchdogTimeout = watchdogTimeout ?? WATCHDOG_TIMEOUT_DEFAULT_SECS;
    this.addresses = owners?.map(ethers.utils.getAddress);
    if (aaveProtectionHandler) {
      const handler = ethers.utils.getAddress(aaveProtectionHandler);
      if (
        chainId !== SupportedChainId.MAINNET ||
        handler === ethers.constants.AddressZero
      ) {
        throw new Error(
          "Aave protection requires a nonzero handler on Ethereum mainnet"
        );
      }
      if (
        !(
          this.addresses?.length ||
          Object.values(filterPolicy.owners ?? {}).includes("ACCEPT")
        )
      ) {
        throw new Error(
          "Aave protection requires a protector owner in --only-owner or filterPolicy.owners"
        );
      }
      this.aaveProtectionHandler = handler;
    }

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

    const provider = getProvider(rpc);
    const chainId = (await provider.getNetwork()).chainId;

    configureSdkAdapters(provider);

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
    const { provider, chainId } = this;
    const log = getLogger({ name: "warmUp", chainId });

    // Warm-up runs before the watchdog starts, and any error escaping here
    // reaches `run()` and exits the process - taking down every other chain
    // with it. So bound each RPC call and retry transient failures with
    // backoff, isolating a flaky RPC to the chain it belongs to.
    const rpc = <T>(operation: () => Promise<T>, description: string) =>
      withRetry(
        () => withTimeout(operation(), WARM_UP_RPC_TIMEOUT_MS, description),
        {
          attempts: WARM_UP_RPC_ATTEMPTS,
          baseDelayMs: WARM_UP_RPC_BASE_DELAY_MS,
          onRetry: (attempt, error, delayMs) =>
            log.warn(
              `${description} failed (attempt ${attempt}/${WARM_UP_RPC_ATTEMPTS}), retrying in ${delayMs}ms`,
              error
            ),
        }
      );
    const readBlock = (tag: string | number) =>
      rpc(() => provider.getBlock(tag), `getBlock ${tag}`);
    const checkpoint = this.registry.lastProcessedBlock;
    let head = await readBlock("latest");
    let fromBlock = checkpoint ? checkpoint.number + 1 : this.deploymentBlock;
    const network = chainId.toString();

    this.sync = ChainSync.SYNCING;
    metrics.syncStatus.labels(network).set(0);
    metrics.blockHeight.labels(network).set(checkpoint?.number ?? 0);
    metrics.blockHeightLatest.labels(network).set(head.number);

    if (
      checkpoint?.hash &&
      (await rpc(
        () => isReorg(provider, checkpoint, head),
        "verify previous checkpoint"
      ))
    ) {
      fromBlock = await replayStartBlock(
        checkpoint,
        this.deploymentBlock,
        readBlock
      );
      if (fromBlock > head.number) {
        await persistLastProcessedBlock({ context: this, block: head, log });
      }
    }

    while (fromBlock <= head.number) {
      await this.indexRegistrationPages(fromBlock, head, log, rpc);
      fromBlock = head.number + 1;
      head = await readBlock("latest");
      metrics.blockHeightLatest.labels(network).set(head.number);
      const saved = this.registry.lastProcessedBlock;
      if (
        saved &&
        (await rpc(
          () => isReorg(provider, saved, head),
          "verify refreshed head"
        ))
      ) {
        throw new Error("Chain head changed while warming up");
      }
    }

    this.sync = ChainSync.IN_SYNC;
    metrics.syncStatus.labels(network).set(1);
    log.info(
      oneShot ? "Chain watcher is in sync" : "Chain watcher is warmed up"
    );

    if (oneShot || head.number % this.processEveryNumBlocks === 0) {
      await checkForAndPlaceOrder(this, head);
    }
    if (oneShot) return;
    return await this.subscribeToNewBlocks(head);
  }

  private async indexRegistrationPages(
    fromBlock: number,
    head: providers.Block,
    log: LoggerWithMethods,
    rpc: BoundedRpc
  ) {
    while (fromBlock <= head.number) {
      const toBlock = this.pageSize
        ? Math.min(fromBlock + this.pageSize - 1, head.number)
        : head.number;
      const page =
        toBlock === head.number
          ? head
          : await rpc(
              () => this.provider.getBlock(toBlock),
              `getBlock ${toBlock}`
            );
      await indexRegistrationPage(this, fromBlock, page, log, rpc);
      fromBlock = toBlock + 1;
    }
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
    const savedHead = () =>
      registry.lastProcessedBlock?.hash
        ? registry.lastProcessedBlock
        : lastProcessedBlock;
    const rpc: BoundedRpc = (operation, description) =>
      withTimeout(operation(), RPC_TIMEOUT_MS, description);
    const readBlock = (tag: string | number) =>
      rpc(() => provider.getBlock(tag), `getBlock ${tag}`);
    // Chain callbacks onto a resolved promise so blocks are processed sequentially.
    let processing = Promise.resolve();
    provider.on("block", (blockNumber: number) => {
      metrics.blockHeightLatest.labels(chainId.toString()).set(blockNumber);

      processing = processing.then(async () => {
        try {
          log = getLogger({
            name: loggerName,
            chainId,
            blockNumber,
          });
          log.debug("New block received");

          const block = await readBlock(blockNumber);
          const lastBlockReceived = savedHead();
          const reorg = await rpc(
            () => isReorg(provider, lastBlockReceived, block),
            "verify previous block"
          );
          if (!reorg && block.number <= lastBlockReceived.number) {
            log.debug(`Ignoring stale block ${block.number}`);
            return;
          }

          metrics.blockProducingRate
            .labels(chainId.toString())
            .set(block.timestamp - lastBlockReceived.timestamp);
          let fromBlock = lastBlockReceived.number + 1;
          if (reorg) {
            metrics.reorgsTotal.labels(chainId.toString()).inc();
            fromBlock = await replayStartBlock(
              lastBlockReceived,
              this.deploymentBlock,
              readBlock
            );
            log.warn(
              `Re-org detected at block ${blockNumber}, replaying from ${fromBlock}`
            );
            metrics.reorgDepth
              .labels(chainId.toString())
              .set(Math.max(lastBlockReceived.number - fromBlock + 1, 1));
          }

          if (fromBlock > block.number) {
            await persistLastProcessedBlock({ context: this, block, log });
          } else {
            await this.indexRegistrationPages(fromBlock, block, log, rpc);
          }
          if (block.number % this.processEveryNumBlocks === 0) {
            await checkForAndPlaceOrder(this, block);
          }
        } catch (error) {
          log.error(`Error processing block ${blockNumber}`, error);
        }
      });
    });

    // We run a watchdog to check if we are receiving blocks. This determines if
    // the chain is stuck or not issuing blocks. If running within a kubernetes
    // pod, we don't exit, but we do log an error and set the sync status to unknown.
    while (true) {
      // sleep for 5 seconds
      await asyncSleep(WATCHDOG_FREQUENCY_SECS * 1000);
      const now = Math.floor(new Date().getTime() / 1000);
      const timeElapsed = now - savedHead().timestamp;

      log.debug(`Time since last block processed: ${timeElapsed}s`);

      // If we haven't received a block within `watchdogTimeout` seconds, either signal
      // an error or exit if not running in a kubernetes pod
      const sync = watchdogSyncState(timeElapsed, watchdogTimeout);
      if (sync === ChainSync.IN_SYNC) {
        // Blocks are flowing again (or never stopped). Clear any previous
        // `UNKNOWN` so `/health` reports healthy without needing a restart -
        // otherwise a single transient stall permanently fails the liveness
        // probe and the pod is killed even though it has recovered.
        if (this.sync !== ChainSync.IN_SYNC) {
          log.info(
            `Chain watcher recovered, last block processed ${timeElapsed}s ago`
          );
          this.sync = sync;
        }
        continue;
      }

      log.error(
        `Chain watcher last processed a block ${timeElapsed}s ago (${watchdogTimeout}s timeout configured). Check the RPC.`
      );
      if (isRunningInKubernetesPod()) {
        this.sync = sync;
        continue;
      }

      // We need to handle our own exit here as the process is not running in a
      // kubernetes pod. Exit even if closing the database fails: warm-up is
      // retried as a unit, so letting an error escape here would re-enter
      // `subscribeToNewBlocks` and attach a second `block` listener.
      try {
        await registry.storage.close();
      } catch (error) {
        log.error("Error closing the database while shutting down", error);
      }
      process.exit(1);
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

  /**
   * Flag the chain as no longer in sync.
   *
   * Called when warm-up has been abandoned: nothing is watching this chain any
   * more, so `/health` must stop reporting it healthy even though the process
   * stays up for the chains that are still working.
   */
  public markUnhealthy() {
    this.sync = ChainSync.UNKNOWN;
    metrics.syncStatus.labels(this.chainId.toString()).set(0);
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

async function persistLastProcessedBlock(params: {
  context: ChainContext;
  block: ethers.providers.Block;
  log: LoggerWithMethods;
}) {
  const { context, block, log } = params;

  const previous = context.registry.lastProcessedBlock;
  context.registry.lastProcessedBlock = blockToRegistryBlock(block);
  try {
    await context.registry.write();
  } catch (error) {
    context.registry.lastProcessedBlock = previous;
    throw error;
  }
  log.debug(`Block has been processed`);

  // Set the block metrics
  const chain = context.chainId.toString();
  metrics.blockTimestamp.labels(chain).set(block.timestamp);
  metrics.blockHeight.labels(chain).set(block.number);
}

type BoundedRpc = <T>(
  operation: () => Promise<T>,
  description: string
) => Promise<T>;

async function indexRegistrationPage(
  context: ChainContext,
  fromBlock: number,
  page: providers.Block,
  log: LoggerWithMethods,
  rpc: BoundedRpc
) {
  const { provider, chainId, registry } = context;
  const timer = metrics.processBlockDurationSeconds
    .labels(chainId.toString())
    .startTimer();

  try {
    const events = await rpc(
      () => pollContractForEvents(fromBlock, page.number, context),
      `getLogs ${fromBlock}..${page.number}`
    );
    const checkpoint = registry.lastProcessedBlock;
    // Replays can intentionally start at or before a displaced checkpoint.
    if (
      checkpoint?.hash &&
      fromBlock === checkpoint.number + 1 &&
      (await rpc(
        () => isReorg(provider, checkpoint, page),
        "verify forward checkpoint"
      ))
    ) {
      throw new Error(
        `Checkpoint block ${checkpoint.number} changed while scanning registrations`
      );
    }
    const canonical = await rpc(
      () => provider.getBlock(page.number),
      `verify block ${page.number}`
    );
    if (canonical?.hash !== page.hash) {
      throw new Error(
        `Block ${page.number} changed while scanning registrations`
      );
    }

    for (const event of events) {
      await processNewOrderEvent(context, event);
      metrics.eventsProcessedTotal.labels(chainId.toString()).inc();
    }

    await persistLastProcessedBlock({ context, block: page, log });
  } finally {
    timer();
  }
}

async function replayStartBlock(
  previous: RegistryBlock,
  deploymentBlock: number,
  readBlock: (tag: string | number) => Promise<providers.Block | null>
): Promise<number> {
  // Follow the old fork back to a block whose hash still matches the chain.
  let displaced = await readBlock(previous.hash);
  while (displaced && displaced.number >= deploymentBlock) {
    if ((await readBlock(displaced.number))?.hash === displaced.hash) {
      return displaced.number + 1;
    }
    displaced = await readBlock(displaced.parentHash);
  }
  return deploymentBlock;
}

export function isAaveProtectionOwner(
  { addresses, filterPolicy }: Pick<ChainContext, "addresses" | "filterPolicy">,
  owner: string
): boolean {
  return addresses
    ? addresses.some((address) => address.toLowerCase() === owner.toLowerCase())
    : filterPolicy?.acceptsOwner(owner) === true;
}

export async function pollContractForEvents(
  fromBlock: number,
  toBlock: number,
  { provider, addresses }: Pick<ChainContext, "provider" | "addresses">
): Promise<providers.Log[]> {
  if (addresses?.length === 0) return [];
  const topics = orderRegistrationTopics(addresses);
  const ownerTopics = Array.isArray(topics[1]) ? new Set(topics[1]) : undefined;
  const logs = await provider.getLogs({
    fromBlock,
    toBlock,
    topics,
  });
  return logs.filter(
    (event) =>
      !event.removed &&
      (!ownerTopics || ownerTopics.has(event.topics[1]?.toLowerCase()))
  );
}

function getProvider(rpcUrl: string): providers.Provider {
  const log = getLogger({ name: "getProvider" });

  // if the rpcUrl is a websocket url, use the WebSocketProvider
  if (rpcUrl.toLowerCase().startsWith("ws")) {
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

export async function isReorg(
  provider: providers.Provider,
  previousBlock: Pick<RegistryBlock, "hash" | "number">,
  block: providers.Block
): Promise<boolean> {
  if (block.number === previousBlock.number) {
    return block.hash !== previousBlock.hash;
  }

  if (block.number === previousBlock.number + 1) {
    return block.parentHash !== previousBlock.hash;
  }

  return (
    (await provider.getBlock(previousBlock.number))?.hash !== previousBlock.hash
  );
}

/**
 * Determine the sync state the watchdog should report, given how long ago the
 * last block was processed.
 */
export function watchdogSyncState(
  timeElapsed: number,
  watchdogTimeout: number
): ChainSync {
  return timeElapsed >= watchdogTimeout ? ChainSync.UNKNOWN : ChainSync.IN_SYNC;
}
