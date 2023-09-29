import * as log from "loglevel";
import * as prefix from "loglevel-plugin-prefix";
import { Chalk } from "chalk";
import chalk = require("chalk");

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
  format(level, name, timestamp) {
    return `${chalk.gray(`[${timestamp}]`)} ${colors[level.toUpperCase()](
      level
    )} ${chalk.green(`${name}:`)}`;
  },
});

export default log;
