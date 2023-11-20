# Watch-Tower for Composable CoWs 🐮🎶

## Overview

The [`ComposableCoW`](https://github.com/cowprotocol/composable-cow) conditional order framework requires a watch-tower to monitor the blockchain for new orders, and to post them to the [CoW Protocol `OrderBook` API](https://api.cow.fi/docs/#/). The watch-tower is a standalone application that can be run locally as a script for development, or deployed as a docker container to a server, or dappnode.

## Deployment

If running your own watch-tower instance, you will need the following:

- An RPC node connected to the Ethereum mainnet, Gnosis Chain, or Goerli.
- Internet access to the [CoW Protocol `OrderBook` API](https://api.cow.fi/docs/#/).

**CAUTION**: Conditional order types may consume considerable RPC calls.

**NOTE**: `deployment-block` refers to the block number at which the **`ComposableCoW`** contract was deployed to the respective chain. This is used to optimise the watch-tower by only fetching events from the blockchain after this block number. Refer to [Deployed Contracts](https://github.com/cowprotocol/composable-cow#deployed-contracts) for the respective chains.

**NOTE**: The `--page-size` option is used to specify the number of blocks to fetch from the blockchain when querying historical events (`eth_getLogs`). The default is `5000`, which is the maximum number of blocks that can be fetched in a single request from Infura. If you are running the watch-tower against your own RPC, you may want to set this to `0` to fetch all blocks in one request, as opposed to paging requests.


### Docker

The preferred method of deployment is using `docker`. The watch-tower is available as a docker image on [GitHub](https://github.com/cowprotocol/watch-tower/pkgs/container/watch-tower). The tags available are:

- `latest` - the latest version of the watch-tower.
- `vX.Y.Z` - the version of the watch-tower.
- `main` - the latest version of the watch-tower on the `main` branch.
- `pr-<PR_NUMBER>` - the latest version of the watch-tower on the PR.

As an example, to run the latest version of the watch-tower via `docker`:

```bash
docker run --rm -it \
  ghcr.io/cowprotocol/watch-tower:latest \
  run \
  --chain-config <rpc>,<deployment-block> \
  --page-size 5000
```

**NOTE**: There are multiple optional arguments on the `--chain-config` parameter. For a full explanation of the optional arguments, use the `--help` flag:

  ```bash
  docker run --rm -it \
    ghcr.io/cowprotocol/watch-tower:latest \
    run \
    --help
  ```

### DAppNode

For [DAppNode](https://dappnode.com), the watch-tower is available as a package. This package is held in a [separate repository](https://github.com/cowprotocol/dappnodepackage-cow-watch-tower).

### Running locally

#### Requirements

- `node` (`>= v16.18.0`)
- `yarn`

#### CLI

```bash
# Install dependencies
yarn
# Run watch-tower
yarn cli run --chain-config <rpc>,<deployment-block> --page-size 5000
```

## Architecture

### Events

The watch-tower monitors the following events:

- `ConditionalOrderCreated` - emitted when a _single_ new conditional order is created.
- `MerkleRootSet` - emitted when a new merkle root (ie. `n` conditional orders) is set for a safe.

When a new event is discovered, the watch-tower will:

1. Fetch the conditional order(s) from the blockchain.
2. Post the **discrete** order(s) to the [CoW Protocol `OrderBook` API](https://api.cow.fi/docs/#/).

### Storage (registry)

The watch-tower stores the following state:

- All owners (ie. safes) that have created at least one conditional order.
- All conditional orders by safe that have not expired or been cancelled.

As orders expire, or are cancelled, they are removed from the registry to conserve storage space.

#### Database

The chosen architecture for the storage is a NoSQL (key-value) store. The watch-tower uses the following:

- [`level`](https://www.npmjs.com/package/level)
- Default location: `$PWD/database`

`LevelDB` is chosen it it provides [ACID](https://en.wikipedia.org/wiki/ACID) guarantees, and is a simple key-value store. The watch-tower uses the `level` package to provide a simple interface to the database. All writes are batched, and if a write fails, the watch-tower will throw an error and exit. On restarting, the watch-tower will attempt to re-process from the last block that was successfully indexed, resulting in the database becoming eventually consistent with the blockchain.

##### Schema

The following keys are used:

- `LAST_PROCESSED_BLOCK` - the last block (number, timestamp, and hash) that was processed by the watch-tower.
- `CONDITIONAL_ORDER_REGISTRY` - the registry of conditional orders by safe.
- `CONDITIONAL_ORDER_REGISTRY_VERSION` - the version of the registry. This is used to migrate the registry when the schema changes.
- `LAST_NOTIFIED_ERROR` - the last time an error was notified via Slack. This is used to prevent spamming the slack channel.

### Logging

To control logging level, you can set the `LOG_LEVEL` environment variable with one of the following values: `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`:

```ini
LOG_LEVEL=WARN
```

Additionally, you can enable module specific logging by specifying the log level for the module name:

```ini
# Enable logging for an specific module (chainContext in this case)
LOG_LEVEL=chainContext=INFO

# Of-course, you can provide the root log level, and the override at the same time
#   - All loggers will have WARN level
#   - Except the "chainContext" which will have INFO level
LOG_LEVEL=WARN,chainContext=INFO
```

You can specify more than one overrides

```ini
LOG_LEVEL=chainContext=INFO,_placeOrder=TRACE
```

The module definition is actually a regex pattern, so you can make more complex definitions:

```ini
# Match a logger using a pattern
#  Matches: chainContext:processBlock:100:30212964
#  Matches: chainContext:processBlock:1:30212964
#  Matches: chainContext:processBlock:5:30212964
LOG_LEVEL=chainContext:processBlock:(\d{1,3}):(\d*)$=DEBUG

# Another example
#  Matches: chainContext:processBlock:100:30212964
#  Matches: chainContext:processBlock:1:30212964
#  But not: chainContext:processBlock:5:30212964
LOG_LEVEL=chainContext:processBlock:(100|1):(\d*)$=DEBUG
```

Combine all of the above to control the log level of any modules:

```ini
 LOG_LEVEL="WARN,commands=DEBUG,^checkForAndPlaceOrder=WARN,^chainContext=INFO,_checkForAndPlaceOrder:1:=INFO" yarn cli
```

### API Server

Commands that run the watch-tower in a watching mode, will also start an API server. By default the API server will start on port `8080`. You can change the port using the `--api-port <apiPort>` CLI option.

The server exposes automatically:

- An API, with:
  - Version info: [http://localhost:8080/api/version](http://localhost:8080/api/version)
  - Dump Database: `http://localhost:8080/api/dump/:chainId` e.g. [http://localhost:8080/api/dump/1](http://localhost:8080/api/dump/1)
- Prometheus Metrics: [http://localhost:8080/metrics](http://localhost:8080/metrics)

You can prevent the API server from starting by setting the `--disable-api` flag for the `run` command.

The `/api/version` endpoint, exposes the information in the `package.json`. This can be helpful to identify the version of the watch-tower. Additionally, for environments using `docker`, the environment variable `DOCKER_IMAGE_TAG` can be used to specify the Docker image tag used.

## Developers

### Requirements

- `node` (`>= v16.18.0`)
- `yarn`
- `npm`

### Local development

It is recommended to test against the Goerli testnet. To run the watch-tower:

```bash
# Install dependencies
yarn
# Run watch-tower
yarn cli run --chain-config <rpc>,<deployment-block> --page-size 5000
```

### Testing

To run the tests:

```bash
yarn test
```

### Linting / Formatting

```bash
# To lint the code
yarn lint
```

```bash
# To fix linting errors
yarn lint:fix
```

```bash
# To format the code
yarn fmt
```

### Building the docker image

To build the docker image:

```bash
docker build -t watch-tower .
```
