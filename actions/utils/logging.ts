import assert = require("assert");
import winston = require("winston");
const { Loggly } = require("winston-loggly-bulk");

let initialized = false;

export function initLogging(logglyToken: string, tags: string[]) {
  if (initialized) {
    return;
  }

  initialized = true;
  winston.add(
    new Loggly({
      token: logglyToken,
      subdomain: "cowprotocol",
      tags,
      json: true,
    })
  );

  const consoleOriginal = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    info: console.info,
  };

  type LogLevel = "warn" | "info" | "error" | "debug";
  const logWithLoggly =
    (level: LogLevel) =>
    (...data: any[]) => {
      if (data.length > 1) {
        const [message, meta] = data;
        winston.log({ level, message, meta });
      } else if (data.length === 1) {
        winston.log({ level, message: data[0] });
      }
      consoleOriginal[level](...data);
    };

  // Override the log function since some internal libraries might print something and breaks Tenderly

  console.info = logWithLoggly("info");
  console.warn = logWithLoggly("warn");
  console.error = logWithLoggly("error");
  console.debug = logWithLoggly("debug");
  console.log = logWithLoggly("info");
}
