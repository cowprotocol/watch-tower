import log from "loglevel";
import prefix from "loglevel-plugin-prefix";
import chalk, { Chalk } from "chalk";

const colors: Record<string, Chalk> = {
  TRACE: chalk.magenta,
  DEBUG: chalk.cyan,
  INFO: chalk.blue,
  WARN: chalk.yellow,
  ERROR: chalk.red,
};

prefix.reg(log);
log.enableAll();

prefix.apply(log, {
  timestampFormatter(date) {
    return date.toISOString();
  },
  format(level, name, timestamp) {
    return `${chalk.gray(timestamp)} ${colors[level.toUpperCase()](
      level
    )} ${chalk.green(`${name}:`)}`;
  },
});

export { log as logger };
