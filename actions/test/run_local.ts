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
import { getOrdersStorageKey } from "../model";
import { exit } from "process";
import { SupportedChainId } from "@cowprotocol/cow-sdk";

require("dotenv").config();

const main = async () => {
  // The web3 actions fetches the node url and computes the API based on the current chain id
  const network = process.env.NETWORK;
  assert(network, "network is required");

  const chainId = toChainId(network);
  const testRuntime = await _getRunTime(chainId);

  // Get provider
  const provider = await getProvider(testRuntime.context, chainId);

  // Run one of the 3 Execution modes:
  //  - Single tx: Process just one tx
  //  - Single block: Process just one block
  //  - Watch mode: Watch for new blocks, and process them
  const txEnv = process.env.TX;
  const blockNumberEnv = process.env.BLOCK_NUMBER;
  if (txEnv) {
    // Execute once, for a specific tx
    console.log(
      `[run_local] Processing ONCE for a specific transaction: ${txEnv}...`
    );

    await processTx(provider, txEnv, chainId, testRuntime).catch(() => {
      exit(101);
    });

    console.log(`[run_local] Transaction ${txEnv} has been processed.`);
  } else if (blockNumberEnv) {
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
  } else {
    // Watch for new blocks
    console.log(`[run_local] Subscribe to new blocks for network ${network}`);
    provider.on("block", async (blockNumber: number) => {
      try {
        await processBlock(provider, blockNumber, chainId, testRuntime);
      } catch (error) {
        console.error("[run_local] Error in processBlock", error);
      }
    });
  }
};

async function processBlock(
  provider: ethers.providers.Provider,
  blockNumber: number,
  chainId: number,
  testRuntime: TestRuntime
) {
  const block = await provider.getBlock(blockNumber);

  // Transaction watcher for adding new contracts
  const blockWithTransactions = await provider.getBlockWithTransactions(
    blockNumber
  );
  let hasErrors = false;
  for (const transaction of blockWithTransactions.transactions) {
    hasErrors ||= !(await !_processTx(
      provider,
      block,
      chainId,
      testRuntime,
      transaction
    ));
  }

  hasErrors ||= !(await _pollAndPost({ block, chainId, testRuntime }));

  if (hasErrors) {
    throw new Error("[run_local] Errors found in processing block");
  }
}

async function processTx(
  provider: ethers.providers.Provider,
  tx: string,
  chainId: number,
  testRuntime: TestRuntime
) {
  let hasErrors = false;
  const transaction = await provider.getTransaction(tx);
  if (!transaction.blockNumber) {
    throw new Error(`The transaction ${tx} is not mined yet (no blockNumber)`);
  }
  const block = await provider.getBlock(transaction.blockNumber);
  if (!transaction) {
    throw new Error(`[run_local] Transaction ${tx} not found`);
  }

  hasErrors ||= !(await _processTx(
    provider,
    block,
    chainId,
    testRuntime,
    transaction
  ));
  hasErrors ||= !(await _pollAndPost({ block, chainId, testRuntime }));

  if (hasErrors) {
    throw new Error("[run_local] Errors found in processing TX");
  }
}

async function _processTx(
  provider: ethers.providers.Provider,
  block: ethers.providers.Block,
  chainId: number,
  testRuntime: TestRuntime,
  transaction: ethers.providers.TransactionResponse
): Promise<boolean> {
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
    const result = await testRuntime
      .execute(addContract, testTransactionEvent)
      .then(() => true)
      .catch((e) => {
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

    return result;
  }

  return true;
}

async function _pollAndPost({
  block,
  chainId,
  testRuntime,
}: {
  block: ethers.providers.Block;
  chainId: number;
  testRuntime: TestRuntime;
}) {
  const blockNumber = block.number;

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
    .catch(() => {
      console.log(`[run_local] Error running "checkForAndPlaceOrder" action`);
      return false;
    });
  console.log(
    `[run_local] Result of "checkForAndPlaceOrder" action for block ${blockNumber}: ${_formatResult(
      result
    )}`
  );

  return result;
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
