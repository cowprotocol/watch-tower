import { DumpDbOptions, Registry } from "../types";
import { DBService } from "../services";
import { getLogger } from "../utils";

/**
 * Dump the database as JSON to STDOUT for a given chain ID
 * @param options A dict, but essentially just the chainId
 */
export async function dumpDb(options: DumpDbOptions) {
  const log = getLogger({ name: "commands:dumpDb" });
  const { chainId, databasePath } = options;

  Registry.dump(DBService.getInstance(databasePath), chainId.toString())
    .then((dump) => console.log(dump))
    .catch((error) => {
      log.error("Unexpected thrown when dumping DB", error);
      process.exit(1);
    });
}
