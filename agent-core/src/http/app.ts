import express, { type Express } from "express";
import { httpError } from "../../../shared/errors";
import {
  REQUEST_ID_HEADER,
  errorFields,
  log,
  requestId,
} from "../../../shared/logging";
import type { CoreDependencies } from "./dependencies";
import { registerArtifactRoutes } from "./routes/artifacts";
import { registerHealthRoutes, registerSchemaRoutes } from "./routes/system";
import { registerThreadRoutes } from "./routes/threads";

export function createCoreApp(dependencies: CoreDependencies): Express {
  const { manager } = dependencies;
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const id = requestId(req.get(REQUEST_ID_HEADER));
    res.locals.requestId = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  registerHealthRoutes(app, dependencies);
  registerArtifactRoutes(app, dependencies);
  registerSchemaRoutes(app);
  registerThreadRoutes(app, dependencies);
  app.use(
    (
      error: any,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const { status, ...body } = httpError(error, "agent-core");
      const id = res.locals.requestId ?? requestId(req.get(REQUEST_ID_HEADER));
      log(status >= 500 ? "error" : "debug", "request failed", {
        requestId: id,
        method: req.method,
        path: req.path,
        status,
        code: body.code,
        headersSent: res.headersSent,
        ...manager.redactor.clean(errorFields(error)),
      });
      if (res.headersSent) return _next(error);
      res
        .status(status)
        .json(manager.redactor.clean({ ...body, requestId: id }));
    },
  );
  return app;
}
