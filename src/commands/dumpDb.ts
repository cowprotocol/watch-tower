import { DumpDbOptions, Registry } from "../types";
import { logger, DBService } from "../utils";

/**
 * Dump the database as JSON to STDOUT for a given chain ID
 * @param options A dict, but essentially just the chainId
 */
export async function dumpDb(options: DumpDbOptions) {
  const log = logger.getLogger("commands:dumpDb");
  const { chainId } = options;

  Registry.dump(DBService.getInstance(), chainId.toString())
    .then((dump) => console.log(dump))
    .catch((error) => {
      log.error("Unexpected thrown when dumping DB", error);
      process.exit(1);
    });
}
