import { DumpDbOptions, Registry } from "../types";
import { DBService } from "../utils";

/**
 * Dump the database as JSON to STDOUT for a given chain ID
 * @param options A dict, but essentially just the chainId
 */
export async function dumpDb(options: DumpDbOptions) {
  const { chainId } = options;

  Registry.dump(DBService.getInstance(), chainId.toString())
    .then((dump) => console.log(dump))
    .catch((error) => {
      console.error("Error dumping DB", error);
      process.exit(1);
    });
}
