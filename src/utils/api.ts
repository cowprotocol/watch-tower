import { Server } from "http";
import express, { Request, Response, Router } from "express";
import client from "prom-client";
import { Express } from "express-serve-static-core";
import { getLogger } from "./logging";
import { DBService } from "./db";
import { Registry } from "../types";
import { MetricsService } from "./metrics";
import { version, name, description } from "../../package.json";

export class ApiService {
  protected port: number;
  protected app: Express;
  protected server: Server | null = null;

  constructor(port: number) {
    this.port = port;
    this.app = express();
    this.bootstrap();
  }

  private bootstrap() {
    const collectDefaultMetrics = client.collectDefaultMetrics;
    collectDefaultMetrics();

    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));
    this.app.get("/", (_req: Request, res: Response) => {
      res.send("🐮 Moooo!");
      MetricsService.apiRequestCounter.labels("GET", "/", "200").inc();
    });
    this.app.use("/api", router);
    this.app.get("/metrics", async (_req, res) => {
      res.set("Content-Type", client.register.contentType);
      const response = await client.register.metrics();
      res.send(response);
    });
  }

  get getApp(): Express {
    return this.app;
  }

  async start(): Promise<Server> {
    return await new Promise((resolve, reject) => {
      try {
        const log = getLogger("api");
        if (this.server?.listening) {
          throw new Error("Server is already running");
        }
        this.server = this.app.listen(this.port, () => {
          log.info(
            `Starting Rest API server on port ${this.port}. See http://localhost:8080/api/about`
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

        const log = getLogger("api");
        log.info("Stopping Rest API server");

        this.server.once("close", resolve);
        this.server.close();
      } catch (err) {
        reject(err);
      }
    });
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
  router.get("/about", async (req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/json");
    res.send({
      version,
      name,
      description,
      dockerImageTag: process.env.DOCKER_IMAGE_TAG,
    });
  });
};

export type RouterInitializer = (router: Router) => void;
const routeInitializers: RouterInitializer[] = [aboutRoute, dumpRoute];

const router = Router();
for (const routeInitialize of routeInitializers) {
  routeInitialize(router);
}
