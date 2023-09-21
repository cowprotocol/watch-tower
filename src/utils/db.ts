import { Level } from "level";

export type DBLevel = Level<string, string>;

export default class DBService {
  protected db: DBLevel;

  private static _instance: DBService = new DBService();

  protected constructor() {
    if (DBService._instance) {
      throw new Error(
        "Error: Instantiation failed: Use DBService.getInstance() instead of new."
      );
    }
    DBService._instance = this;

    if (process.env.NODE_IS_TEST === "true") {
      this.db = new Level<string, string>("./database_test", {
        valueEncoding: "json",
        createIfMissing: true,
        errorIfExists: false,
      });
    } else {
      this.db = new Level<string, string>("./database", {
        valueEncoding: "json",
        createIfMissing: true,
        errorIfExists: false,
      });
    }
  }

  public static getInstance(): DBService {
    return DBService._instance;
  }

  public async open() {
    await this.db.open();
  }

  public async close() {
    await this.db.close();
  }

  public getDB() {
    return this.db;
  }
}
