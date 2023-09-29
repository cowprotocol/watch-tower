import {
  setLevel,
  getLogger as getLoggerLogLevel,
  LogLevelNames,
  Logger,
} from "loglevel";
import rootLogger from "loglevel";
import prefix from "loglevel-plugin-prefix";
import chalk, { Chalk } from "chalk";

const LEVELS = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "SILENT"];

interface LogLevelOverride {
  regex: RegExp;
  level: LogLevelNames;
}

// Set the default log level
setRootLogLevel(process.env.LOG_LEVEL || "WARN");

// Init Log level overrides
const logLevelOverrides = initLogLevelOverrides();

const colors: Record<string, Chalk> = {
  TRACE: chalk.magenta,
  DEBUG: chalk.cyan,
  INFO: chalk.blue,
  WARN: chalk.yellow,
  ERROR: chalk.red,
};

prefix.reg(rootLogger);
prefix.apply(rootLogger, {
  timestampFormatter(date) {
    return date.toISOString();
  },
  format(level, name, timestamp) {
    return `${chalk.gray(timestamp)} ${colors[level.toUpperCase()](
      level
    )} ${chalk.green(`${name}:`)}`;
  },
});

export function getLogger(loggerName: string): Logger {
  const logger = getLoggerLogLevel(loggerName);

  const logLevelOverride = logLevelOverrides.find((override) =>
    override.regex.test(loggerName)
  );

  if (logLevelOverride) {
    logger.setLevel(logLevelOverride.level);
  }
  return logger;
}

export function setRootLogLevel(level: string) {
  setLevel(getLogLevel(level));
}

function initLogLevelOverrides(): LogLevelOverride[] {
  if (!process.env.DEBUG) {
    return [];
  }

  const loggerDefinitions = process.env.DEBUG.split(",").map((logger) =>
    logger.trim()
  );
  return loggerDefinitions.map((loggerDefinition) => {
    const loggerDef = loggerDefinition
      .split("=")
      .map((logger) => logger.trim());

    if (loggerDef.length !== 2) {
      throw new Error(
        'Invalid logger definition. Please use "loggerModulePattern=LEVEL". Offending definition: ' +
          loggerDefinition
      );
    }

    try {
      return {
        regex: new RegExp(loggerDef[0]),
        level: getLogLevel(loggerDef[1]),
      };
    } catch (e) {
      throw new Error(
        `Error parsing logger overrides: "${loggerDefinition}". ${
          (e as any)?.message
        }`
      );
    }
  });
}

function getLogLevel(level: string): LogLevelNames {
  if (!LEVELS.includes(level)) {
    throw new Error(
      `Invalid log level: ${level}. Please use one of ${LEVELS.join(", ")}`
    );
  }

  return level.toLowerCase() as LogLevelNames;
}
