# Watch Tower for Composable CoWs 🐮🎶

A watch tower has been implementing using standalone ethers.js. By means of _emitted Event_ and new block monitoring, conditional orders can run autonomously.

Notably, with the `ConditionalOrderCreated` and `MerkleRootSet` events, multiple conditional orders can be created for one safe - in doing so, the actions maintain a registry of:

1. Safes that have created _at least one conditional order_.
2. All payloads for conditional orders by safe that have not expired or been cancelled.
3. All part orders by `orderUid` containing their status (`SUBMITTED`, `FILLED`) - the `Trade` on `GPv2Settlement` is monitored to determine if an order is `FILLED`.

As orders expire, or are cancelled, they are removed from the registry to conserve storage space.

### Local testing

This is assuming that you have followed the instructions for deploying the stack on `anvil` in [local deployment](#Local-deployment)

From the root directory of the repository:

```bash
yarn
yarn ts-node ./src/index.ts run --rpc http://127.0.0.1:8545 --deployment-block <deployment-block> --contract-address <contract-address> --page-size 0
```

### Watch tower state

The watch tower stores data in a leveldb database. The database is stored by default in the `./database` directory. Writes to the database are batched, and if writes fail, the watch tower will throw an error and exit. On restarting, the watch tower will attempt to re-process the last block that was indexed.

### Deployment

If running your own watch tower, or deploying for production:

```bash
yarn
yarn ts-node ./src/index.ts run --rpc <rpc-url> --deployment-block <deployment-block> --contract-address <contract-address> --page-size 0
```

## Developers

### Requirements

- `node` (`>= v16.18.0`)
- `yarn`
- `npm`

### Environment setup

Copy the `.env.example` to `.env` and set the applicable configuration variables for the testing / deployment environment.

#### Local deployment

For local integration testing, such as local debugging of tenderly actions, it may be useful deploying to a _forked_ mainnet environment. Information on how to do this is available in the [ComposableCoW repository](https://github.com/cowprotocol/composable-cow).

#### Run the standalone watch tower

```bash
yarn
yarn ts-node ./src/index.ts run --rpc <rpc-url> --deployment-block <deployment-block> --page-size 0
```

> Useful for debugging locally the actions. Also could be used to create an order for an old block in case there was a failure of WatchTowers indexing it.

Make sure you setup the environment (so you have your own `.env` file).

Decide in which network you want to run the actions and provide the additional parameters for that network. For example:

```ini
NETWORK=100
NODE_URL_100=https://your-rpc-endpoint
NODE_USER_100=optionally-provide-user-if-auth-is-required
NODE_PASSWORD_100=optionally-provide-password-if-auth-is-required
```

```bash
# Install dependencies
yarn

# Run actions locally
#   - It will synchronize the database with the blockchain from the deployment block
#   - It will start watching and processing new blocks
#   - As a result, new Composable Cow orders will be discovered and posted to the OrderBook API
yarn ts-node ./src/index.ts run --rpc <rpc-url> --deployment-block <deployment-block> --page-size 0
```
