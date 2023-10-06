import {
  toConditionalOrderParams,
  getLogger,
  handleExecutionError,
  isComposableCowCompatible,
} from "../utils";
import { BytesLike, ethers } from "ethers";

import {
  ComposableCoW,
  ComposableCoWInterface,
  ConditionalOrderCreatedEvent,
  IConditionalOrder,
  MerkleRootSetEvent,
  ComposableCoW__factory,
  Owner,
  Proof,
  Registry,
} from "../types";

import { ChainContext } from "./chainContext";
import { ConditionalOrderParams } from "@cowprotocol/cow-sdk";
import {
  addContractsErrorsTotal,
  addContractsRunDurationSeconds,
  merkleRootTotal,
  newContractsTotal,
  singleOrdersTotal,
  totalActiveOrders,
  totalActiveOwners,
} from "../utils/metrics";

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
  const timer = addContractsRunDurationSeconds
    .labels(chainId.toString())
    .startTimer();
  try {
    await _addContract(context, event);
  } catch (err) {
    addContractsErrorsTotal
      .labels(context.chainId.toString(), "addContract")
      .inc();
    handleExecutionError(err);
  } finally {
    timer();
  }
}

async function _addContract(
  context: ChainContext,
  event: ConditionalOrderCreatedEvent
) {
  const log = getLogger("addContract");
  const composableCow = ComposableCoW__factory.createInterface();
  const { provider, registry } = context;
  const { transactionHash: tx, blockNumber } = event;

  // Process the logs
  let hasErrors = false;
  let numContractsAdded = 0;

  // Do not process logs that are not from a `ComposableCoW`-compatible contract
  // This is a *normal* case, if the contract is not `ComposableCoW`-compatible
  // then we do not need to do anything, and therefore don't flag as an error.
  if (!isComposableCowCompatible(await provider.getCode(event.address))) {
    return;
  }
  const { error, added } = await _registerNewOrder(
    event,
    composableCow,
    registry
  );
  if (added) {
    newContractsTotal.labels(context.chainId.toString()).inc();
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

export async function _registerNewOrder(
  event: ConditionalOrderCreatedEvent | MerkleRootSetEvent,
  composableCow: ComposableCoWInterface,
  registry: Registry
): Promise<{ error: boolean; added: boolean }> {
  const log = getLogger("addContract:_registerNewOrder");
  const { transactionHash: tx } = event;
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
      singleOrdersTotal.labels(registry.network).inc();
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
          merkleRootTotal.labels(registry.network).inc();
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
 * @param owner to add the conditional order to
 * @param params for the conditional order
 * @param proof for the conditional order (if it is part of a merkle root)
 * @param composableCow address of the contract that emitted the event
 * @param registry of all conditional orders
 */
export function add(
  tx: string,
  owner: Owner,
  params: ConditionalOrderParams,
  proof: Proof | null,
  composableCow: string,
  registry: Registry
) {
  const log = getLogger("addContract:add");
  const { handler, salt, staticInput } = params;
  if (registry.ownerOrders.has(owner)) {
    const conditionalOrders = registry.ownerOrders.get(owner);
    log.info(
      `Adding conditional order to already existing owner contract ${owner}`,
      { tx, handler, salt, staticInput }
    );
    let exists = false;
    // Iterate over the conditionalOrders to make sure that the params are not already in the registry
    for (const conditionalOrder of conditionalOrders?.values() ?? []) {
      // Check if the params are in the conditionalOrder
      if (conditionalOrder.params === params) {
        exists = true;
        break;
      }
    }

    // If the params are not in the conditionalOrder, add them
    if (!exists) {
      conditionalOrders?.add({
        tx,
        params: { handler, salt, staticInput },
        proof,
        orders: new Map(),
        composableCow,
      });
      totalActiveOrders.labels(registry.network).inc();
    }
  } else {
    log.info(`Adding conditional order to new owner contract ${owner}:`, {
      tx,
      handler,
      salt,
      staticInput,
    });
    registry.ownerOrders.set(
      owner,
      new Set([{ tx, params, proof, orders: new Map(), composableCow }])
    );
    totalActiveOwners.labels(registry.network).inc();
    totalActiveOrders.labels(registry.network).inc();
  }
}

/**
 * Flush the conditional orders of an owner that do not have the merkle root set
 * @param owner to check for conditional orders to flush
 * @param root the merkle root to check against
 * @param registry of all conditional orders
 */
export function flush(owner: Owner, root: BytesLike, registry: Registry) {
  if (registry.ownerOrders.has(owner)) {
    const conditionalOrders = registry.ownerOrders.get(owner);
    if (conditionalOrders !== undefined) {
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
  }
}
