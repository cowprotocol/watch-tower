import {
  TestRuntime,
  TestBlockEvent,
  TestTransactionEvent,
} from "@tenderly/actions-test";
import { checkForAndPlaceOrder } from "../checkForAndPlaceOrder";
import { addContract } from "../addContract";
import { ethers } from "ethers";
import assert = require("assert");
import { toChainId, getProvider } from "../utils";
import { ReplayPlan, getOrdersStorageKey } from "../model";
import { exit } from "process";
import { SupportedChainId } from "@cowprotocol/cow-sdk";
import { ComposableCoW__factory } from "../types/factories/ComposableCoW__factory";

require("dotenv").config();

const DEFAULT_PAGE_SIZE = 5000;
const DEFAULT_DEPLOYMENT_BLOCK = 0;

const main = async () => {
  // The web3 actions fetches the node url and computes the API based on the current chain id
  const network = process.env.NETWORK;
  assert(network, "network is required");

  const chainId = toChainId(network);
  const testRuntime = await _getRunTime(chainId);

  // Get provider
  const provider = await getProvider(testRuntime.context, chainId);

  // Run one of the 3 Execution modes (single block, watch mode, or rebuild mode)
  const blockNumberEnv = process.env.BLOCK_NUMBER;
  const contractAddressEnv = process.env.CONTRACT_ADDRESS;
  if (blockNumberEnv && !contractAddressEnv) {
    // Execute once, for a specific block
    const isLatest = blockNumberEnv === "latest";
    const blockNumber = isLatest
      ? await provider.getBlockNumber()
      : Number(blockNumberEnv);

    console.log(
      `[run_local] Processing ONCE for a specific block: ${
        isLatest ? `latest (${blockNumber})` : blockNumber
      }...`
    );
    await processBlock(provider, blockNumber, chainId, testRuntime).catch(
      () => {
        exit(100);
      }
    );
    console.log(`[run_local] Block ${blockNumber} has been processed.`);
  } else if (!blockNumberEnv && !contractAddressEnv){
    // Watch for new blocks
    console.log(`[run_local] Subscribe to new blocks for network ${network}`);
    provider.on("block", async (blockNumber: number) => {
      try {
        await processBlock(provider, blockNumber, chainId, testRuntime);
      } catch (error) {
        console.error("[run_local] Error in processBlock", error);
      }
    });
  } else if (contractAddressEnv) {
    // If no blockNumberEnv is provided, then we rebuild the state from the default deployment block
    if (!blockNumberEnv) {
      console.log(`[run_rebuild] No block number provided, using default deployment block`);
    } else {
      assert(!isNaN(Number(blockNumberEnv)), "blockNumber must be a number");
    }
    let fromBlock = blockNumberEnv ? Number(blockNumberEnv) : DEFAULT_DEPLOYMENT_BLOCK;

    // Rebuild the state
    console.log(`[run_rebuild] Rebuild the state of the conditional orders from the historical events.`);
    const contractAddress = process.env.CONTRACT_ADDRESS;
    assert(contractAddress && ethers.utils.isAddress(contractAddress), "contract address is required");
    const pageSize = process.env.PAGE_SIZE ? parseInt(process.env.PAGE_SIZE) : DEFAULT_PAGE_SIZE;

    // 1. Record the current block number - useful with paging
    let currentBlockNumber = await provider.getBlockNumber();
    console.log(`[run_rebuild] Current block number: ${currentBlockNumber}`);

    // 2. Connect to the contract instance
    const contract = ComposableCoW__factory.connect(contractAddress, provider);
    
    // 3. Define the filter.
    const filter = contract.filters.ConditionalOrderCreated();

    // 4. Get the historical events
    const replayPlan: ReplayPlan = {}
    let toBlock;
    do {
      toBlock = (pageSize == 0) ? 'latest' : fromBlock + (pageSize - 1);
      if (typeof toBlock !== 'string' && toBlock > currentBlockNumber) {
          // refresh the current block number
          currentBlockNumber = await provider.getBlockNumber();
          toBlock = (toBlock > currentBlockNumber) ? currentBlockNumber : toBlock;

          console.log(`[run_rebuild] Reaching tip of chain, current block number: ${currentBlockNumber}`);
      }

      console.log(`[run_rebuild] Processing events from block ${fromBlock} to block ${toBlock}`);

      const events = await contract.queryFilter(filter, fromBlock, toBlock);

      console.log(`[run_rebuild] Found ${events.length} events`);

      // 5. Process the events
      for (const event of events) {
        if (replayPlan[event.blockNumber] === undefined) {
          replayPlan[event.blockNumber] = new Set();
        }

        replayPlan[event.blockNumber].add(event.transactionHash);
      }

      // only possible string value for toBlock is 'latest'
      if (typeof toBlock !== 'string') {
          fromBlock = toBlock + 1;
      }
    } while (toBlock !== 'latest' && (typeof toBlock !== 'string' && toBlock != currentBlockNumber));

    // 5. Replay the blocks by iterating over the replayPlan
    for (const [blockNumber, txHints] of Object.entries(replayPlan)) {
      console.log(`[run_rebuild] Processing block ${blockNumber}`);
      await processBlock(provider, Number(blockNumber), chainId, testRuntime, Array.from(txHints)).catch(
        () => {
          exit(100);
        }
      );
      console.log(`[run_rebuild] Block ${blockNumber} has been processed.`);
    }
  }
};

async function processBlock(
  provider: ethers.providers.Provider,
  blockNumber: number,
  chainId: number,
  testRuntime: TestRuntime,
  txHints?: string[]
) {
  const block = await provider.getBlock(blockNumber);

  // Transaction watcher for adding new contracts
  const blockWithTransactions = await provider.getBlockWithTransactions(
    blockNumber
  );
  let hasErrors = false;
  for (const transaction of blockWithTransactions.transactions) {
    if (txHints && !txHints.includes(transaction.hash)) {
      continue;
    }
    const receipt = await provider.getTransactionReceipt(transaction.hash);
    if (receipt) {
      const {
        hash,
        from,
        value,
        nonce,
        gasLimit,
        maxPriorityFeePerGas,
        maxFeePerGas,
      } = transaction;

      const testTransactionEvent: TestTransactionEvent = {
        blockHash: block.hash,
        blockNumber: block.number,
        from,
        hash,
        network: chainId.toString(),
        logs: receipt.logs,
        input: "",
        value: value.toString(),
        nonce: nonce.toString(),
        gas: gasLimit.toString(),
        gasUsed: receipt.gasUsed.toString(),
        cumulativeGasUsed: receipt.cumulativeGasUsed.toString(),
        gasPrice: receipt.effectiveGasPrice.toString(),
        gasTipCap: maxPriorityFeePerGas ? maxPriorityFeePerGas.toString() : "",
        gasFeeCap: maxFeePerGas ? maxFeePerGas.toString() : "",
        transactionHash: transaction.hash,
      };

      // run action
      console.log(`[run_local] Run "addContract" action for TX ${hash}`);
      const result = await testRuntime
        .execute(addContract, testTransactionEvent)
        .then(() => true)
        .catch((e) => {
          hasErrors = true;
          console.error(
            `[run_local] Error running "addContract" action for TX:`,
            e
          );
          return false;
        });
      console.log(
        `[run_local] Result of "addContract" action for TX ${hash}: ${_formatResult(
          result
        )}`
      );
    }
  }

  // Block watcher for creating new orders
  const testBlockEvent = new TestBlockEvent();
  testBlockEvent.blockNumber = blockNumber;
  testBlockEvent.blockDifficulty = block.difficulty?.toString();
  testBlockEvent.blockHash = block.hash;
  testBlockEvent.network = chainId.toString();

  // run action
  console.log(`[run_local] checkForAndPlaceOrder for block ${blockNumber}`);
  const result = await testRuntime
    .execute(checkForAndPlaceOrder, testBlockEvent)
    .then(() => true)
    .catch((e) => {
      hasErrors = true;
      console.log(`[run_local] Error running "checkForAndPlaceOrder" action`);
      return false;
    });
  console.log(
    `[run_local] Result of "checkForAndPlaceOrder" action for block ${blockNumber}: ${_formatResult(
      result
    )}`
  );

  if (hasErrors) {
    throw new Error("[run_local] Errors found in processing block");
  }
}

async function _getRunTime(chainId: SupportedChainId): Promise<TestRuntime> {
  const testRuntime = new TestRuntime();

  // Add secrets from local env (.env) for current network
  const envNames = [
    `NODE_URL_${chainId}`,
    `NODE_USER_${chainId}`,
    `NODE_PASSWORD_${chainId}`,
    "SLACK_WEBHOOK_URL",
    "NOTIFICATIONS_ENABLED",
    "SENTRY_DSN",
    "LOGGLY_TOKEN",
  ];
  for (const name of envNames) {
    const envValue = process.env[name];
    if (envValue) {
      await testRuntime.context.secrets.put(name, envValue);
    }
  }

  // Load storage from env
  const storage = process.env.STORAGE;
  if (storage) {
    const storageFormatted = JSON.stringify(JSON.parse(storage), null, 2);
    await testRuntime.context.storage.putStr(
      getOrdersStorageKey(chainId.toString()),
      storage
    );
  }

  return testRuntime;
}

function _formatResult(result: boolean) {
  return result ? "✅" : "❌";
}

(async () => await main())();
