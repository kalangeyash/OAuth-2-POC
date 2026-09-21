import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "./config.js";
import { discover, DiscoveryError } from "./discovery.js";
import { FhirRequestError, MissingPatientContextError, ReauthRequiredError } from "./fhir.js";
import { LabStoppedError } from "./lab.js";
import { OAuthFlowError } from "./oauth.js";
import { redact } from "./redaction.js";
import { apiRouter } from "./routes/api.js";
import { authRouter } from "./routes/auth.js";
import { demoRouter } from "./routes/demo.js";
import { createSessionMiddleware, type TeachingError } from "./session.js";
import { logSafely, record } from "./wireLog.js";

const app = express();
app.disable("x-powered-by");

// In development the browser reaches this server through the Vite proxy (same origin).
// CORS only matters if the UI calls this port directly.
app.use(cors({ origin: config.clientUrl, credentials: true }));
app.use(createSessionMiddleware(config.sessionSecret));
app.use(express.json({ limit: "10kb" }));

app.use(authRouter);
app.use(apiRouter);
app.use(demoRouter);

// After "npm run build", serve the compiled React app from this same port.
const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../client");
if (existsSync(clientDist)) app.use(express.static(clientDist));

app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  const { httpStatus, teaching } = toTeachingError(error);
  logSafely(`[error] ${req.method} ${req.path}`, teaching);
  // Discovery, token and FHIR failures are already in the wire log. Record anything else here.
  if (error instanceof OAuthFlowError || httpStatus === 500) {
    record({
      direction: "internal",
      category: "error",
      step: teaching.step,
      result: teaching,
      outcome: "error",
      explanation: `The flow stopped with an error at "${teaching.step}": ${teaching.message}`,
    });
  }
  if (req.session) req.session.lastError = teaching;

  // API calls get JSON. Browser navigations (/auth/login, /launch, /callback) go back to the UI.
  if (req.path.startsWith("/api/") || req.method !== "GET") {
    res.status(httpStatus).json(redact({ error: teaching }));
  } else {
    res.redirect(config.clientUrl);
  }
});

function toTeachingError(error: unknown): { httpStatus: number; teaching: TeachingError } {
  if (error instanceof DiscoveryError) {
    return {
      httpStatus: 502,
      teaching: {
        step: "SMART discovery",
        endpoint: error.url,
        status: error.status,
        message: error.message,
        concept: "The client learns its OAuth endpoints from the FHIR server's .well-known/smart-configuration.",
      },
    };
  }
  if (error instanceof ReauthRequiredError) {
    return {
      httpStatus: 401,
      teaching: {
        step: "FHIR API call",
        message: error.message,
        reauthRequired: true,
        concept: "Token lifecycle: a rejected access token is refreshed once; if that fails, the user must authorize again.",
      },
    };
  }
  if (error instanceof MissingPatientContextError) {
    return {
      httpStatus: 409,
      teaching: {
        step: "Patient context",
        message: error.message,
        concept: "SMART launch context: the authorization server tells the client which patient was authorized.",
      },
    };
  }
  if (error instanceof FhirRequestError) {
    return {
      httpStatus: 502,
      teaching: { step: "FHIR API call", endpoint: error.url, status: error.status, message: error.message },
    };
  }
  if (error instanceof LabStoppedError) {
    return {
      httpStatus: 409,
      teaching: {
        step: error.step,
        message: error.message,
        concept: "Protocol debugger: the flow was stopped on purpose at a breakpoint. Nothing after it was sent.",
      },
    };
  }
  if (error instanceof OAuthFlowError) {
    return { httpStatus: 400, teaching: { step: error.step, message: error.message } };
  }
  return {
    httpStatus: 500,
    teaching: { step: "Server", message: error instanceof Error ? error.message : String(error) },
  };
}

app.listen(config.port, () => {
  console.log("\nSMART on FHIR OAuth 2.0 teaching demo. DEMO / SYNTHETIC DATA ONLY. Not production software.");
  console.log(`OAuth client (Node/Express) listening on http://localhost:${config.port}`);
  console.log(`UI: ${config.clientUrl}\n`);
  discover(config.fhirBaseUrl).catch((error: Error) => {
    console.error(`SMART discovery failed at startup: ${error.message} (the UI can retry)`);
  });
});
