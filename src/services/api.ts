import { Server } from "http";
import express, { Request, Response, Router } from "express";
import { Express } from "express-serve-static-core";
import * as client from "prom-client";
import { getLogger } from "../utils/logging";
import { DBService, ChainContext } from "../services";
import { Registry } from "../types";
import { version, name, description } from "../../package.json";

export class ApiService {
  protected port: number;
  protected app: Express;
  protected server: Server | null = null;

  protected chainContexts: ChainContext[] = [];

  private static _instance: ApiService | undefined;

  protected constructor(port?: number) {
    this.port = port || 8080;
    this.app = express();
    this.bootstrap();
  }

  private bootstrap() {
    this.app.use(express.json());

    client.collectDefaultMetrics();
    this.app.use(express.urlencoded({ extended: true }));
    this.app.get("/", (_req: Request, res: Response) => {
      res.send("🐮 Moooo!");
    });
    this.app.use("/metrics", (_req: Request, res: Response) => {
      const { register } = client;
      res.setHeader("Content-Type", register.contentType);
      register.metrics().then((data) => res.status(200).send(data));
    });
    this.app.get("/health", async (_req: Request, res: Response) => {
      const health = ChainContext.health;
      res.status(health.overallHealth ? 200 : 503).send(health);
    });
    this.app.use("/config", (_req: Request, res: Response) => {
      res.setHeader("Content-Type", "application/json");
      res.status(200).send(
        this.chainContexts.map(
          ({
            chainId,
            contract,
            deploymentBlock,
            dryRun,
            filterPolicy,
            pageSize,
            processEveryNumBlocks,
            addresses,
          }) => ({
            chainId,
            contract: contract.address,
            deploymentBlock,
            dryRun,
            filterPolicy,
            pageSize,
            processEveryNumBlocks,
            addresses,
          })
        )
      );
    });
    this.app.use("/api", router);
  }

  public static getInstance(port?: number): ApiService {
    if (!ApiService._instance) {
      ApiService._instance = new ApiService(port);
    }
    return ApiService._instance;
  }

  async start(): Promise<Server> {
    return await new Promise((resolve, reject) => {
      try {
        const log = getLogger({ name: "api:start" });
        if (this.server?.listening) {
          throw new Error("Server is already running");
        }
        this.server = this.app.listen(this.port, () => {
          log.info(
            `Rest API server is running on port ${this.port}. See http://localhost:${this.port}/api/version`
          );
        });

        resolve(this.server);
      } catch (err) {
        reject(err);
      }
    });
  }

  async stop(): Promise<void> {
    return await new Promise((resolve, reject) => {
      try {
        if (!this.server) {
          throw new Error("Server is not running");
        }

        const log = getLogger({ name: "api:stop" });
        log.info("Stopping Rest API server...");

        this.server.once("close", resolve);
        this.server.close();
      } catch (err) {
        reject(err);
      }
    });
  }

  setChainContexts(chainContexts: ChainContext[]) {
    this.chainContexts = chainContexts;
  }

  getChainContexts() {
    return this.chainContexts;
  }
}

const dumpRoute = (router: Router) => {
  router.get("/dump/:chainId", async (req: Request, res: Response) => {
    try {
      const dump = await Registry.dump(
        DBService.getInstance(),
        req.params.chainId
      );
      res.setHeader("Content-Type", "application/json");
      res.send(dump);
    } catch (err) {
      res.send(JSON.stringify(err));
    }
  });
};

const aboutRoute = (router: Router) => {
  router.get("/version", async (req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/json");
    res.send({
      version,
      name,
      description,
      dockerImageTag: process.env.DOCKER_IMAGE_TAG, // Optional: convenient way to inform about the used docker image tag in docker environments
    });
  });
};

export type RouterInitializer = (router: Router) => void;
const routeInitializers: RouterInitializer[] = [aboutRoute, dumpRoute];

const router = Router();
for (const routeInitialize of routeInitializers) {
  routeInitialize(router);
}
