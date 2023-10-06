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

```bash
# Install dependencies
yarn

# Run actions locally
#   - It will synchronize the database with the blockchain from the deployment block
#   - It will start watching and processing new blocks
#   - As a result, new Composable Cow orders will be discovered and posted to the OrderBook API
yarn ts-node ./src/index.ts run --rpc <rpc-url> --deployment-block <deployment-block> --page-size 0
```

## Logging

To control logging level, you can set the `LOG_LEVEL` environment variable with one of the following values: `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `SILENT`:

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
 LOG_LEVEL="WARN,commands=DEBUG,^checkForAndPlaceOrder=WARN,^chainContext=INFO,_checkForAndPlaceOrder:1:=INFO" yarn ts-node ./src/index.ts
```

## API Server

The run command will expose by default a server on port `8080`.

The server exposes automatically:

- An API, with:
  - Version info: [http://localhost:8080/api/version](http://localhost:8080/api/version)
  - Dump Database: `http://localhost:8080/api/dump/:chainId` e.g. [http://localhost:8080/api/dump/1](http://localhost:8080/api/dump/1)
- Prometheus Metrics: [http://localhost:8080/metrics](http://localhost:8080/metrics)

You can prevent the server from starting by setting the `--disable-api` flag for the `run` command.

Additionally, you can change the default port using the `--api-port <apiPort>` CLI option.

The `/api/version` endpoint, exposes the information in the package.json. This can be helpful to identify the version of the watch tower. Additionally, for environments using docker, the environment variable `DOCKER_IMAGE_TAG` can be used to specify the Docker image tag used.
