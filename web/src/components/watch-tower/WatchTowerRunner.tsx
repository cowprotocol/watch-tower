import { useCallback, useState } from "react";
import { run } from "./run";

export type WatchTowerState =
  | "NOT_INITIALIZED"
  | "RUNNING"
  | "STOPPED"
  | "ERROR";

export function WatchTowerRunner() {
  const [state, setState] = useState<WatchTowerState>("NOT_INITIALIZED");

  const initWatchTower = useCallback(() => {
    setState("RUNNING");
    run(/*{
      apiPort: 8080,
      rpc: "https://goerli.infura.io/v3/a857ea92ec7140b89cf1ad1fe8c5e72a",
      databasePath: "./db",
      deploymentBlock: 9493135,
      pageSize: 5000,
      disableApi: false,
      oneShot: false,
      logLevel: "DEBUG",
      silent: false,
      dryRun: false,
      watchdogTimeout: 30,
      orderBookApi: "https://api.cow.fi/goerli",
      slackWebhook: undefined,
    }*/)
      .then(() => {
        setState("STOPPED");
      })
      .catch((_e) => {
        setState("ERROR");
      });
  }, []);

  return (
    <>
      {state === "NOT_INITIALIZED" ? (
        <>
          <h1>Watch Tower</h1>
          <p>
            This is an experiment. Click the button bellow to start the Watch
            Tower
          </p>
          <button onClick={initWatchTower}>Click me</button>
        </>
      ) : (
        <>
          <h1>
            Watch Tower: <span style={{ fontSize: 20 }}>🚀 {state}</span>
          </h1>
        </>
      )}
    </>
  );
}
