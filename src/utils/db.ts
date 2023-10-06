import { DatabaseOptions, Level } from "level";
import { getLogger } from "./logging";

const DEFAULT_DB_LOCATION = "./database";

export type DBLevel = Level<string, string>;

export class DBService {
  protected db: DBLevel;

  private static _instance: DBService = new DBService();

  protected constructor(path = DEFAULT_DB_LOCATION) {
    if (DBService._instance) {
      throw new Error(
        "Error: Instantiation failed: Use DBService.getInstance() instead of new."
      );
    }
    DBService._instance = this;
    const options: DatabaseOptions<string, string> = {
      valueEncoding: "json",
      createIfMissing: true,
      errorIfExists: false,
    };

    this.db = new Level<string, string>(path, options);
  }

  public static getInstance(): DBService {
    return DBService._instance;
  }

  public async open() {
    await this.db.open();
  }

  public async close() {
    const log = getLogger("dbService:close");
    log.info("Closing database...");
    await this.db.close();
  }

  public getDB() {
    return this.db;
  }
}
