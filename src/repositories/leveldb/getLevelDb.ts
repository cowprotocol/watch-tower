import { DatabaseOptions, Level } from "level";

export type DBLevel = Level<string, string>;
const DB_CACHE: Record<string, Level> = {};

export function getLevelDb(path: string): DBLevel {
  let db = DB_CACHE[path];

  if (!db) {
    const options: DatabaseOptions<string, string> = {
      valueEncoding: "json",
      createIfMissing: true,
      errorIfExists: false,
    };

    db = new Level<string, string>(path, options);
    DB_CACHE[path] = db;
  }

  return db;
}

export function closeAllDbs() {
  for (const path in DB_CACHE) {
    DB_CACHE[path].close();
  }
}
