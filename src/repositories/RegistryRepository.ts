type Registry = string; // TODO: define in model
import { DBLevel, getLevelDb } from "./leveldb/getLevelDb";

const DB_KEY = "registry";
const DEFAULT_DB_LOCATION = "./database";

export interface RegistryRepository {
  get(): Promise<Registry>;
  save(registry: Registry): Promise<void>;
}

/**
 * LevelDB implementation of RegistryRepository
 */
export class RegistryRepositoryImpl implements RegistryRepository {
  db: DBLevel;

  constructor(path = DEFAULT_DB_LOCATION) {
    this.db = getLevelDb(path);
  }

  get(): Promise<Registry> {
    console.log("get registry");
    return this.db.get(DB_KEY);
  }
  save(registry: Registry): Promise<void> {
    console.log("saving registry", registry);

    return this.db.put(DB_KEY, registry);
  }
}
