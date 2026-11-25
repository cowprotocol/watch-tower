import {
  ConditionalOrder,
  ConditionalOrderParams,
} from "@cowprotocol/sdk-composable";
import { BytesLike, ethers } from "ethers";

import { ChainContext } from "../../services/chain";
import {
  ComposableCoW,
  ComposableCoW__factory,
  ConditionalOrderCreatedEvent,
  IConditionalOrder,
  MerkleRootSetEvent,
  Owner,
  Proof,
  Registry,
} from "../../types";
import {
  getAreConditionalOrderParamsEqual,
  getLogger,
  handleExecutionError,
  metrics,
  toConditionalOrderParams,
} from "../../utils";
import { policy } from "../polling/filtering";

const composableCow = ComposableCoW__factory.createInterface();

/**
 * Process a new order event for `ComposableCoW` contract:
 * - `ConditionalOrderCreated`
 * - `MerkleRootSet`
 *
 * @param context chain context
 * @param event transaction event
 */
export async function processNewOrderEvent(
  context: ChainContext,
  event: ConditionalOrderCreatedEvent
) {
  const { chainId, registry } = context;

  const action = async () => {
    const { transactionHash: tx, blockNumber } = event;

    const log = getLogger({
      name: "processNewOrderEvent",
      chainId,
      blockNumber: event.blockNumber,
    });

    // Process the logs
    let hasErrors = false;
    let numContractsAdded = 0;

    const { error, added } = await decodeAndAddOrder(event, context);

    if (added) {
      const network = context.chainId.toString();
      metrics.ownersTotal.labels(network).inc();
      metrics.activeOrdersTotal.labels(network).inc();
      numContractsAdded++;
    } else {
      log.error(
        `Failed to register Smart Order from tx ${tx} on block ${blockNumber}. Error: ${error}`
      );
    }

    hasErrors ||= error;

    if (numContractsAdded > 0) {
      log.debug(`Added ${numContractsAdded} conditional orders`);

      // Write the registry to disk. Don't catch errors, let them bubble up
      await registry.write();

      // Throw execution error if there was at least one error
      if (hasErrors) {
        throw Error("Error adding conditional order. Event: " + event);
      }
    } else {
      log.info(
        `No conditional order added for tx ${tx} on block ${blockNumber}`
      );
    }
  };

  await metrics.measureTime({
    action,
    labelValues: [chainId.toString()],
    durationMetric: metrics.addContractsRunDurationSeconds,
    totalRunsMetric: metrics.addContractRunsTotal,
    errorHandler: handleExecutionError,
    errorMetric: metrics.addContractsErrorsTotal,
  });
}

async function decodeAndAddOrder(
  event: ConditionalOrderCreatedEvent | MerkleRootSetEvent,
  context: ChainContext
): Promise<{ error: boolean; added: boolean }> {
  const { chainId, registry } = context;
  const log = getLogger({
    name: "decodeAndAddOrder",
    chainId,
    blockNumber: event.blockNumber,
  });
  const { transactionHash: tx } = event;
  const { network } = registry;
  let added = false;

  try {
    // Check if the log is a ConditionalOrderCreated event
    if (
      event.topics[0] === composableCow.getEventTopic("ConditionalOrderCreated")
    ) {
      const eventLog = event as ConditionalOrderCreatedEvent;
      // Decode the log
      const [owner, params] = composableCow.decodeEventLog(
        "ConditionalOrderCreated",
        eventLog.data,
        eventLog.topics
      ) as [string, IConditionalOrder.ConditionalOrderParamsStruct];

      // Attempt to add the conditional order to the registry
      added = addOrder(
        eventLog.transactionHash,
        owner,
        toConditionalOrderParams(params),
        null,
        eventLog.address,
        event.blockNumber,
        context
      );
      if (added) {
        metrics.singleOrdersTotal.labels(network).inc();
      }
    } else if (
      event.topics[0] == composableCow.getEventTopic("MerkleRootSet")
    ) {
      const eventLog = event as MerkleRootSetEvent;
      const [owner, root, proof] = composableCow.decodeEventLog(
        "MerkleRootSet",
        eventLog.data,
        eventLog.topics
      ) as [string, BytesLike, ComposableCoW.ProofStruct];

      // First need to flush the owner's conditional orders that do not have the merkle root set
      flush(owner, root, registry);

      // Only continue processing if the proofs have been emitted
      if (proof.location === 1) {
        // Decode the proof.data
        const proofData = ethers.utils.defaultAbiCoder.decode(
          ["bytes[]"],
          proof.data as BytesLike
        );

        for (const order of proofData) {
          // Decode the order
          const decodedOrder = ethers.utils.defaultAbiCoder.decode(
            [
              "bytes32[]",
              "tuple(address handler, bytes32 salt, bytes staticInput)",
            ],
            order as BytesLike
          );
          // Attempt to add the conditional order to the registry

          added = addOrder(
            event.transactionHash,
            owner,
            toConditionalOrderParams(decodedOrder[1]),
            { merkleRoot: root, path: decodedOrder[0] },
            eventLog.address,
            event.blockNumber,
            context
          );
          if (added) {
            metrics.merkleRootTotal.labels(network).inc();
          }
        }
      }
    }
  } catch (err) {
    log.error(
      `Error handling ConditionalOrderCreated/MerkleRootSet event for tx: ${tx}` +
        err
    );
    return { error: true, added };
  }

  return { error: false, added };
}

/**
 * Attempt to add a conditional order to the registry
 *
 * @param tx transaction that created the conditional order
 * @param owner to add the conditional order to
 * @param params for the conditional order
 * @param proof for the conditional order (if it is part of a merkle root)
 * @param composableCow address of the contract that emitted the event
 * @param registry of all conditional orders
 */
function addOrder(
  tx: string,
  owner: Owner,
  params: ConditionalOrderParams,
  proof: Proof | null,
  composableCow: string,
  blockNumber: number,
  context: ChainContext
): boolean {
  const { chainId, registry, filterPolicy } = context;
  const log = getLogger({ name: "addOrder", chainId, blockNumber });
  const { handler, salt, staticInput } = params;
  const { network, ownerOrders } = registry;

  const feeHandler = context.feeTokenSwaps?.handler;
  const feeSwapComposableCow =
    feeHandler && handler.toLowerCase() === feeHandler
      ? context.contract.address.toLowerCase()
      : undefined;
  if (
    feeSwapComposableCow &&
    (proof !== null || composableCow.toLowerCase() !== feeSwapComposableCow)
  ) {
    return false;
  }

  const conditionalOrderParams = toConditionalOrderParams(params);
  const conditionalOrderId = ConditionalOrder.leafToId(params);

  // Apply the filter policy, in case this order should be dropped
  if (filterPolicy) {
    const filterResult = filterPolicy.preFilter({
      conditionalOrderId,
      transaction: tx,
      owner,
      conditionalOrderParams,
    });

    if (filterResult === policy.FilterAction.DROP) {
      // Drop the order
      log.info("Not adding the conditional order. Reason: AcceptPolicy: DROP");
      return false;
    }
  }

  const order = {
    id: conditionalOrderId,
    tx,
    params,
    proof,
    orders: new Map(),
    composableCow,
  };
  const conditionalOrders = ownerOrders.get(owner);
  if (conditionalOrders) {
    log.info(`Adding conditional order to already existing owner ${owner}`, {
      conditionalOrderId,
      tx,
      handler,
      salt,
      staticInput,
    });
    for (const conditionalOrder of conditionalOrders) {
      if (!getAreConditionalOrderParamsEqual(conditionalOrder.params, params))
        continue;
      if (
        !feeSwapComposableCow ||
        (conditionalOrder.proof === null &&
          conditionalOrder.composableCow.toLowerCase() === feeSwapComposableCow)
      )
        return false;
      conditionalOrders.delete(conditionalOrder);
      metrics.activeOrdersTotal.labels(chainId.toString()).dec();
    }

    conditionalOrders.add(order);
    return true;
  } else {
    // Add the order for new owner
    log.info(`Adding conditional order to new owner ${owner}:`, {
      conditionalOrderId,
      tx,
      handler,
      salt,
      staticInput,
    });
    ownerOrders.set(owner, new Set([order]));

    metrics.activeOwnersTotal.labels(network).inc();
    return true;
  }
}

/**
 * Flush the conditional orders of an owner that do not have the merkle root set
 * @param owner to check for conditional orders to flush
 * @param root the merkle root to check against
 * @param registry of all conditional orders
 */
function flush(owner: Owner, root: BytesLike, registry: Registry) {
  if (!registry.ownerOrders.has(owner)) return;

  const conditionalOrders = registry.ownerOrders.get(owner);

  if (conditionalOrders === undefined) return;

  for (const conditionalOrder of conditionalOrders.values()) {
    if (
      conditionalOrder.proof !== null &&
      conditionalOrder.proof.merkleRoot !== root
    ) {
      // Delete the conditional order
      conditionalOrders.delete(conditionalOrder);
    }
  }
}
