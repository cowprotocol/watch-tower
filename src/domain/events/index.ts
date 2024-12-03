import {
  getAreConditionalOrderParamsEqual,
  getLogger,
  handleExecutionError,
  metrics,
  toConditionalOrderParams,
} from "../../utils";
import { BytesLike, ethers } from "ethers";

import {
  ComposableCoW,
  ComposableCoW__factory,
  ComposableCoWInterface,
  ConditionalOrderCreatedEvent,
  IConditionalOrder,
  MerkleRootSetEvent,
  Owner,
  Proof,
  Registry,
} from "../../types";
import { ConditionalOrder, ConditionalOrderParams } from "@cowprotocol/cow-sdk";

import { ChainContext } from "../../services/chain";

const composableCow = ComposableCoW__factory.createInterface();
const log = getLogger("addContract:_addContract");

/**
 * Listens to these events on the `ComposableCoW` contract:
 * - `ConditionalOrderCreated`
 * - `MerkleRootSet`
 * @param context chain context
 * @param event transaction event
 */
export async function addContract(
  context: ChainContext,
  event: ConditionalOrderCreatedEvent
) {
  const { chainId } = context;
  await metrics.measureTime({
    action: () => _addContract(context, event),
    labelValues: [chainId.toString()],
    durationMetric: metrics.addContractsRunDurationSeconds,
    totalRunsMetric: metrics.addContractRunsTotal,
    errorHandler: handleExecutionError,
    errorMetric: metrics.addContractsErrorsTotal,
  });
}

async function _addContract(
  context: ChainContext,
  event: ConditionalOrderCreatedEvent
) {
  const { registry } = context;
  const { transactionHash: tx, blockNumber } = event;

  // Process the logs
  let hasErrors = false;
  let numContractsAdded = 0;

  const { error, added } = await registerNewOrder(
    event,
    composableCow,
    registry
  );

  if (added) {
    metrics.ownersTotal.labels(context.chainId.toString()).inc();
    numContractsAdded++;
  } else {
    log.error(
      `Failed to register Smart Order from tx ${tx} on block ${blockNumber}. Error: ${error}`
    );
  }

  hasErrors ||= error;

  if (numContractsAdded > 0) {
    log.debug(`Added ${numContractsAdded} contracts`);

    // Write the registry to disk. Don't catch errors, let them bubble up
    await registry.write();

    // Throw execution error if there was at least one error
    if (hasErrors) {
      throw Error("Error adding conditional order. Event: " + event);
    }
  } else {
    log.info(`No contracts added for tx ${tx} on block ${blockNumber}`);
  }
}

async function registerNewOrder(
  event: ConditionalOrderCreatedEvent | MerkleRootSetEvent,
  composableCow: ComposableCoWInterface,
  registry: Registry
): Promise<{ error: boolean; added: boolean }> {
  const log = getLogger("addContract:registerNewOrder");
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
      add(
        eventLog.transactionHash,
        owner,
        toConditionalOrderParams(params),
        null,
        eventLog.address,
        registry
      );
      added = true;
      metrics.singleOrdersTotal.labels(network).inc();
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
          add(
            event.transactionHash,
            owner,
            toConditionalOrderParams(decodedOrder[1]),
            { merkleRoot: root, path: decodedOrder[0] },
            eventLog.address,
            registry
          );
          added = true;
          metrics.merkleRootTotal.labels(network).inc();
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
 * Attempt to add an owner's conditional order to the registry
 *
 * @param tx transaction that created the conditional order
 * @param owner to add the conditional order to
 * @param params for the conditional order
 * @param proof for the conditional order (if it is part of a merkle root)
 * @param composableCow address of the contract that emitted the event
 * @param registry of all conditional orders
 */
function add(
  tx: string,
  owner: Owner,
  params: ConditionalOrderParams,
  proof: Proof | null,
  composableCow: string,
  registry: Registry
) {
  const log = getLogger("addContract:add");
  const { handler, salt, staticInput } = params;
  const { network, ownerOrders } = registry;

  const conditionalOrderId = ConditionalOrder.leafToId(params);
  if (ownerOrders.has(owner)) {
    const conditionalOrders = ownerOrders.get(owner);
    log.info(
      `Adding conditional order to already existing owner contract ${owner}`,
      { conditionalOrderId, tx, handler, salt, staticInput }
    );
    let exists = false;
    // Iterate over the conditionalOrders to make sure that the params are not already in the registry
    for (const conditionalOrder of conditionalOrders?.values() ?? []) {
      // Check if the params are in the conditionalOrder
      if (conditionalOrder) {
        const areConditionalOrderParamsEqual =
          getAreConditionalOrderParamsEqual(conditionalOrder.params, params);

        // TODO: delete this log after testing
        if (
          areConditionalOrderParamsEqual &&
          conditionalOrder.params !== params
        ) {
          log.error(
            "Conditional order params are equal but not the same",
            conditionalOrder.id,
            JSON.stringify(params)
          );
        }
      }

      // TODO: this is a shallow comparison, should we do a deep comparison?
      if (conditionalOrder.params === params) {
        exists = true;
        break;
      }
    }

    // If the params are not in the conditionalOrder, add them
    if (!exists) {
      conditionalOrders?.add({
        id: conditionalOrderId,
        tx,
        params: { handler, salt, staticInput },
        proof,
        orders: new Map(),
        composableCow,
      });
      metrics.activeOrdersTotal.labels(network).inc();
    }
  } else {
    log.info(`Adding conditional order to new owner contract ${owner}:`, {
      conditionalOrderId,
      tx,
      handler,
      salt,
      staticInput,
    });
    registry.ownerOrders.set(
      owner,
      new Set([
        {
          id: conditionalOrderId,
          tx,
          params,
          proof,
          orders: new Map(),
          composableCow,
        },
      ])
    );
    // TODO: why twice?
    metrics.activeOwnersTotal.labels(network).inc();
    metrics.activeOrdersTotal.labels(network).inc();
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
