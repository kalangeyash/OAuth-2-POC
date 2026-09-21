import { Router, type Request } from "express";
import { config } from "../config.js";
import { discover, type Discovery } from "../discovery.js";
import { streamEvents } from "../eventStream.js";
import { decide, labState, resetLab, setLabMode } from "../lab.js";
import { OAuthFlowError } from "../oauth.js";
import { getAuthorizedPatient, getLabs } from "../fhir.js";
import { redact } from "../redaction.js";
import { safeHeaders } from "../safeView.js";
import { diffScopes, unadvertisedScopes } from "../scope.js";
import { advanceFlow, failFlow, initialFlow, SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS } from "../session.js";
import { INJECTIONS, LAB_MODES, type InjectionId, type LabMode } from "../timeline.js";
import { clearEntries, listEntries, nextEntryId, record } from "../wireLog.js";

export const apiRouter = Router();

/**
 * Safe metadata only. Built field by field so that no token, code_verifier or client secret
 * can end up in the response. Provider error text is passed through redact() as well.
 */
apiRouter.get("/api/session", (req, res) => {
  const { auth, lastError } = req.session;
  res.json(redact({
    authorized: Boolean(auth),
    scope: auth?.grantedScope ?? null,
    requestedScope: auth?.requestedScope ?? config.scopes,
    patientId: auth?.patientId ?? null,
    expiresIn: auth?.expiresIn ?? null,
    secondsRemaining: auth?.expiresAt ? Math.max(0, Math.round((auth.expiresAt - Date.now()) / 1000)) : null,
    hasRefreshToken: Boolean(auth?.refreshToken),
    hasIdToken: Boolean(auth?.idToken),
    fhirBaseUrl: auth?.fhirBaseUrl ?? config.fhirBaseUrl,
    idTokenClaims: auth?.idTokenClaims ?? null,
    scopeDiff: auth ? diffScopes(auth.requestedScope, auth.grantedScope) : null,
    flow: req.session.flow ?? initialFlow(),
    awaitingAuthorizationServer: Boolean(req.session.pendingAuth),
    lastError: lastError ?? null,
    demo: req.session.demo ?? null,
    scopeComparison: { narrow: req.session.narrowScope ?? null, broad: req.session.broadScope ?? null },
    // The real cookie configuration, and whether the browser sent the cookie on THIS request.
    // Its value is never included.
    sessionCookie: {
      name: SESSION_COOKIE_NAME,
      httpOnly: SESSION_COOKIE_OPTIONS.httpOnly,
      sameSite: SESSION_COOKIE_OPTIONS.sameSite,
      secure: SESSION_COOKIE_OPTIONS.secure,
      maxAgeSeconds: SESSION_COOKIE_OPTIONS.maxAge / 1000,
      sentWithThisRequest: (req.get("cookie") ?? "").includes(`${SESSION_COOKIE_NAME}=`),
    },
    tokenStorage: "server-side session (express-session MemoryStore)",
  }));
});

// ---------------------------------------------------------------------------
// The protocol debugger (server/src/lab.ts)
// ---------------------------------------------------------------------------

apiRouter.get("/api/lab", (_req, res) => {
  res.json(labState());
});

apiRouter.post("/api/lab/mode", (req, res) => {
  const mode = String(req.body?.mode ?? "");
  if (!(mode in LAB_MODES)) throw new OAuthFlowError("Protocol debugger", `Unknown mode "${mode}".`);
  res.json(setLabMode(mode as LabMode));
});

/** The presenter's decision at the current breakpoint: send (one step), run (to the end) or abort. */
apiRouter.post("/api/lab/decide", (req, res) => {
  const breakpointId = Number(req.body?.breakpointId);
  const action = String(req.body?.action ?? "");
  const inject = req.body?.inject === undefined || req.body?.inject === null ? undefined : String(req.body.inject);
  if (action !== "send" && action !== "run" && action !== "abort") {
    throw new OAuthFlowError("Protocol debugger", `Unknown action "${action}".`);
  }
  if (inject !== undefined && !(inject in INJECTIONS)) {
    throw new OAuthFlowError("Protocol debugger", `Unknown injection "${inject}".`);
  }
  let accepted: boolean;
  try {
    accepted = decide(breakpointId, action, inject as InjectionId | undefined);
  } catch (error) {
    throw new OAuthFlowError("Protocol debugger", (error as Error).message);
  }
  res.status(accepted ? 200 : 409).json({ accepted, state: labState() });
});

/** Reset: releases any pause (the flow stops), returns to run mode and forgets the last demo and error. */
apiRouter.post("/api/lab/reset", (req, res) => {
  resetLab();
  delete req.session.demo;
  delete req.session.lastError;
  delete req.session.broadScope;
  if (req.body?.clearLog === true) clearEntries();
  res.json(labState());
});

apiRouter.get("/api/discovery", async (_req, res) => {
  res.json(discoveryView(await discover(config.fhirBaseUrl)));
});

apiRouter.post("/api/discovery/refresh", async (_req, res) => {
  record({
    direction: "react-client",
    category: "discovery",
    step: "Refresh SMART discovery",
    method: "POST",
    endpoint: "/api/discovery/refresh",
    outcome: "info",
  });
  res.json(discoveryView(await discover(config.fhirBaseUrl, { force: true })));
});

// Neither route reads a patient ID from the request.
// The authorized patient comes from the token context stored in the session.
apiRouter.get("/api/patient", async (req, res) => {
  recordDataRequest(req, "Request patient", "Patient");
  const wasAuthorized = Boolean(req.session.auth);
  try {
    const patient = await getAuthorizedPatient(req.session);
    advanceFlow(req.session, 8);
    res.json({ patient });
  } catch (error) {
    if (wasAuthorized) failFlow(req.session, 8);
    throw error;
  }
});

apiRouter.get("/api/labs", async (req, res) => {
  recordDataRequest(req, "Request laboratory results", "Observation");
  const wasAuthorized = Boolean(req.session.auth);
  try {
    const labs = await getLabs(req.session);
    advanceFlow(req.session, 8);
    res.json(labs);
  } catch (error) {
    if (wasAuthorized) failFlow(req.session, 8);
    throw error;
  }
});

/** Step 9 is reported by the React app after it has rendered the FHIR data. */
apiRouter.post("/api/flow/rendered", (req, res) => {
  if (req.session.auth && req.session.flow?.[7] === "done") {
    advanceFlow(req.session, 9);
    record({
      direction: "react-client",
      category: "fhir",
      step: "Patient and labs rendered",
      method: "POST",
      endpoint: req.path,
      timeline: [{ step: "render", status: "done" }],
      outcome: "ok",
      notes: ["React reports that the patient and lab data are on screen. It never held a token to get them."],
    });
  }
  res.json({ ok: true });
});

/** Entries are redacted when they are recorded, so this can only ever return redacted data. */
apiRouter.get("/api/wirelog", (req, res) => {
  res.json({ entries: listEntries(Number(req.query.since) || 0), latestId: nextEntryId() - 1 });
});

/** Clearing reaches every open tab through the event stream. */
apiRouter.delete("/api/wirelog", (_req, res) => {
  clearEntries();
  res.json({ ok: true });
});

/** The live event stream (Server-Sent Events). Carries only entries record() has already redacted. */
apiRouter.get("/api/events", (req, res) => {
  streamEvents(req, res);
});

function recordDataRequest(req: Request, step: string, resource: "Patient" | "Observation"): void {
  const browserSupplied = firstString(req.query.patient) ?? null;
  const used = req.session.auth?.patientId ?? null;
  const notes = ["The browser asks the Node server. It sends no token and no patient ID, only its session cookie."];
  if (browserSupplied !== null) {
    notes[0] = "The browser asks the Node server with its session cookie, and tries to choose a patient in the URL.";
    notes.push(`Ignored browser-supplied ?patient=${browserSupplied}. The patient comes from the token context.`);
  }
  record({
    direction: "react-client",
    category: "patient-context",
    step,
    method: "GET",
    endpoint: req.path,
    params: browserSupplied !== null ? { patient: browserSupplied } : undefined,
    paramsIn: browserSupplied !== null ? "query" : undefined,
    requestHeaders: safeHeaders({ Cookie: req.get("cookie") }),
    timeline: [{ step: resource === "Patient" ? "request-patient" : "request-observations", status: "active" }],
    detail: { kind: "patient-request", resource, browserSupplied, used, ignored: browserSupplied !== null },
    outcome: "info",
    explanation:
      browserSupplied !== null
        ? `The browser asked for patient "${browserSupplied}". The backend ignores that and will only request the patient named in the token response.`
        : `React asks our own server for the ${resource === "Patient" ? "patient" : "lab results"}. It sends only its session cookie: no token, no patient ID.`,
    security:
      "The browser cannot pick a patient: the backend reads the patient ID from the token context stored in the session, never from the request.",
    notes,
  });
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return firstString(value[0]);
  return typeof value === "string" ? value : undefined;
}

function discoveryView(discovery: Discovery) {
  return {
    fhirBaseUrl: discovery.fhirBaseUrl,
    url: discovery.url,
    fetchedAt: discovery.fetchedAt,
    authorization_endpoint: discovery.authorizationEndpoint ?? null,
    token_endpoint: discovery.tokenEndpoint ?? null,
    scopes_supported: discovery.scopesSupported ?? null,
    code_challenge_methods_supported: discovery.codeChallengeMethodsSupported ?? null,
    capabilities: discovery.capabilities ?? null,
    warnings: discovery.warnings,
    requestedScope: config.scopes,
    unadvertisedScopes: unadvertisedScopes(config.scopes, discovery.scopesSupported),
    document: discovery.document,
  };
}
