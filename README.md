# Watch Tower for Composable CoWs 🐮🎶

A watchdog has been implementing using [Tenderly Actions](https://docs.tenderly.co/web3-actions/intro-to-web3-actions). By means of _emitted Event_ and new block monitoring, conditional orders can run autonomously.

Notably, with the `ConditionalOrderCreated` and `MerkleRootSet` events, multiple conditional orders can be created for one safe - in doing so, the actions maintain a registry of:

1. Safes that have created _at least one conditional order_.
2. All payloads for conditional orders by safe that have not expired or been cancelled.
3. All part orders by `orderUid` containing their status (`SUBMITTED`, `FILLED`) - the `Trade` on `GPv2Settlement` is monitored to determine if an order is `FILLED`.

As orders expire, or are cancelled, they are removed from the registry to conserve storage space.

### Local testing

This is assuming that you have followed the instructions for deploying the stack on `anvil` in [local deployment](#Local-deployment)

From the root directory of the repository:

```bash
yarn build
yarn ts-node ./actions/test/run_local.ts
```

### Watch tower state

As the Tenderly watch tower stores data in an abstracted manner, and there have been cases witnessed in production where the storage
has reported odd errors, it is useful to be able to rebuild the state of what _should_ be in the watch tower for quality assurance /
resilience purposes.

To run the state rebuilder locally, use the previous command in [Local testing](#Local-testing) and set the environment variables:

- `BLOCK_NUMBER`: The block number to start from (defaults to `0`)
- `PAGE_SIZE`: The page size for `eth_getLogs` (defaults to `5000` to support Infura)
- `CONTRACT_ADDRESS`: The address of the `ComposableCoW` contract.

Other environment variables such as the RPC node URL and notifications MUST be set as well.

### Deployment

If running your own watch tower, or deploying for production:

```bash
tenderly actions deploy
```

Make sure you configure the secrets in Tenderly:

- `NODE_URL_${network}`: RPC Node URL
- `NODE_USER_${network}`: (optional) RPC Node user name for basic auth.
- `NODE_PASSWORD_${network}`: (optional) RPC Node password name for basic auth.
- `NOTIFICATIONS_ENABLED`: (default `true`) Set to `false` to disable Slack notifications
- `SLACK_WEBHOOK_URL`: Slack Webhook (required only if notifications are enabled)
- `SENTRY_DSN`: (optional) Sentry DSN code. If present, it will enable Sentry notifications

## Developers

### Requirements

- `node` (`>= v16.18.0`)
- `yarn`
- `npm`
- `tenderly`

### Environment setup

Copy the `.env.example` to `.env` and set the applicable configuration variables for the testing / deployment environment.

#### Local deployment

For local integration testing, such as local debugging of tenderly actions, it may be useful deploying to a _forked_ mainnet environment. Information on how to do this is available in the [ComposableCoW repository](https://github.com/cowprotocol/composable-cow).

#### Run Tenderly Web3 Actions locally

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
# Build Actions
yarn build:actions

# Run actions locally
#   - It will start watching and processing new blocks
#   - As a result, new Composable Cow orders will be discovered and posted to the OrderBook API
yarn start:actions

# You can re-process an old block by defining the following environment variables:
#   - Add an env TX: Process only one transaction (takes precedence over BLOCK_NUMBER)
#   - Add an env BLOCK_NUMBER: Process only one block
yarn start:actions
```
