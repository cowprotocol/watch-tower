import {
  setLevel,
  getLogger as getLoggerLogLevel,
  LogLevelNames,
} from "loglevel";
import rootLogger from "loglevel";
import prefix from "loglevel-plugin-prefix";
import chalk, { ChalkInstance } from "chalk";
import { SupportedChainId } from "@cowprotocol/cow-sdk";

const DEFAULT_LOG_LEVEL = "INFO";
const LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "SILENT"];

interface LogLevelOverride {
  regex: RegExp;
  level: LogLevelNames;
}

const COLORS: Record<string, ChalkInstance> = {
  TRACE: chalk.magenta,
  DEBUG: chalk.cyan,
  INFO: chalk.blue,
  WARN: chalk.yellow,
  ERROR: chalk.red,
};

let logLevelOverrides: LogLevelOverride[] | undefined = undefined;

export function initLogging({ logLevel }: { logLevel?: string }) {
  if (logLevelOverrides) {
    throw new Error("Logging already initialized");
  }

  // Init Log level overrides
  logLevelOverrides = setLogLevel(logLevel);

  prefix.reg(rootLogger);
  prefix.apply(rootLogger, {
    timestampFormatter(date) {
      return date.toISOString();
    },
    format(level, name, timestamp) {
      return `${chalk.gray(timestamp)} ${COLORS[level.toUpperCase()](
        level,
      )} ${chalk.green(`${name}:`)}`;
    },
  });
}

export interface LoggerWithMethods {
  trace: (...msg: any[]) => void;
  debug: (...msg: any[]) => void;
  info: (...msg: any[]) => void;
  warn: (...msg: any[]) => void;
  error: (...msg: any[]) => void;
}

interface GetLoggerParams {
  name: string;
  chainId?: SupportedChainId;
  blockNumber?: number;
  ownerNumber?: number;
  orderNumber?: number;
  args?: string[];
}

/**
 * Get the log prefix for a given logger. This is used to add context to the log messages.
 */
function getLogPrefix({
  chainId,
  blockNumber,
  ownerNumber,
  orderNumber,
  args = [],
}: GetLoggerParams) {
  const chainString = chainId ? `${chainId}` : "";
  const blockString = blockNumber ? `@${blockNumber}` : "";
  const ownerString = ownerNumber ? `#${ownerNumber}` : "";
  const orderString = orderNumber ? `.${orderNumber}` : "";
  const argsString = args.length > 0 ? " " + args.join(":") : "";

  return chainString + blockString + ownerString + orderString + argsString;
}

export function getLogger(params: GetLoggerParams): LoggerWithMethods {
  if (!logLevelOverrides) {
    throw new Error("Logging hasn't been initialized");
  }
  const { name } = params;
  const logger = getLoggerLogLevel(name);
  const prefix = getLogPrefix(params);

  const logLevelOverride = logLevelOverrides.find((override) =>
    override.regex.test(name),
  );

  if (logLevelOverride) {
    logger.setLevel(logLevelOverride.level);
  }

  const fmtLogMessage = (msg: any[]) => (prefix ? [prefix, ...msg] : msg);

  const customLogger: LoggerWithMethods = {
    trace: (...msg: any[]) => logger.trace(...fmtLogMessage(msg)),
    debug: (...msg: any[]) => logger.debug(...fmtLogMessage(msg)),
    info: (...msg: any[]) => logger.info(...fmtLogMessage(msg)),
    warn: (...msg: any[]) => logger.warn(...fmtLogMessage(msg)),
    error: (...msg: any[]) => logger.error(...fmtLogMessage(msg)),
  };

  return customLogger;
}

function setRootLogLevel(level: string) {
  setLevel(getLogLevel(level));
}

function setLogLevel(logLevel = DEFAULT_LOG_LEVEL) {
  let rootLogLevelDefined = false;

  // Get the log level overrides
  let logLevelOverrides: LogLevelOverride[];
  if (logLevel) {
    const loggerDefinitions = logLevel
      .split(",")
      .map((logger) => logger.trim());

    logLevelOverrides = loggerDefinitions.reduce<LogLevelOverride[]>(
      (acc, loggerDefinition) => {
        if (!loggerDefinition.includes("=")) {
          // If the loggerDefinition does not include a "=" character then it refers to the root logger
          setRootLogLevel(loggerDefinition);
          rootLogLevelDefined = true;
          return acc;
        }

        // Split logger definition into parts (e.g. "my-module=DEBUG")
        const loggerDef = loggerDefinition
          .split("=")
          .map((logger) => logger.trim());

        if (loggerDef.length !== 2) {
          throw new Error(
            'Invalid logger definition. Please use "loggerModulePattern=LEVEL". Offending definition: ' +
              loggerDefinition,
          );
        }

        try {
          acc.push({
            regex: new RegExp(loggerDef[0]),
            level: getLogLevel(loggerDef[1]),
          });
          return acc;
        } catch (e) {
          throw new Error(
            `Error parsing logger overrides: "${loggerDefinition}". ${
              (e as any)?.message
            }`,
          );
        }
      },
      [],
    );
  } else {
    logLevelOverrides = [];
  }

  // If not specified, set the root log level to the default
  if (!rootLogLevelDefined) {
    setRootLogLevel(DEFAULT_LOG_LEVEL);
  }

  return logLevelOverrides;
}

function getLogLevel(level: string): LogLevelNames {
  if (!LEVELS.includes(level)) {
    throw new Error(
      `Invalid log level: ${level}. Please use one of ${LEVELS.join(", ")}`,
    );
  }

  return level.toLowerCase() as LogLevelNames;
}
