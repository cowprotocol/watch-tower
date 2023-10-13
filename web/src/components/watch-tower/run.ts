// import { DBService } from "@/utils";
// import { RunSingleOptions } from "@/types";

import { RegistryRepositoryImpl } from "@/repositories/RegistryRepository";

export async function run(): Promise<void> {
  console.log("RUNNING WATCH TOWER");
  try {
    // const storage = DBService.getInstance("./watch-tower");
    const registryRepository = new RegistryRepositoryImpl("./watch-tower");
    const value = await registryRepository.get("test");
    console.log("result", value);
    registryRepository.save("test");

    console.log("STORAGE", {});

    // const chainContext = await ChainContext.init(options, storage);
    // const runPromise = chainContext.warmUp(watchdogTimeout, oneShot);

    // Run the block watcher after warm up for the chain
    // await runPromise;
  } catch (error) {
    console.log("Unexpected error thrown when running watchtower", error);
  }
}
