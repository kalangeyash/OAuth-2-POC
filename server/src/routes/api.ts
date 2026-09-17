import { Router, type Request } from "express";
import { config } from "../config.js";
import { discover, type Discovery } from "../discovery.js";
import { getAuthorizedPatient, getLabs } from "../fhir.js";
import { redact } from "../redaction.js";
import { diffScopes, unadvertisedScopes } from "../scope.js";
import { advanceFlow, failFlow, initialFlow } from "../session.js";
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
    fhirBaseUrl: auth?.fhirBaseUrl ?? config.fhirBaseUrl,
    idTokenClaims: auth?.idTokenClaims ?? null,
    scopeDiff: auth ? diffScopes(auth.requestedScope, auth.grantedScope) : null,
    flow: req.session.flow ?? initialFlow(),
    awaitingAuthorizationServer: Boolean(req.session.pendingAuth),
    lastError: lastError ?? null,
    demo: req.session.demo ?? null,
    scopeComparison: { narrow: req.session.narrowScope ?? null, broad: req.session.broadScope ?? null },
  }));
});

apiRouter.get("/api/discovery", async (_req, res) => {
  res.json(discoveryView(await discover(config.fhirBaseUrl)));
});

apiRouter.post("/api/discovery/refresh", async (_req, res) => {
  record({
    direction: "browser-client",
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
  recordDataRequest(req, "Request patient");
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
  recordDataRequest(req, "Request laboratory results");
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
  if (req.session.auth && req.session.flow?.[7] === "done") advanceFlow(req.session, 9);
  res.json({ ok: true });
});

/** Entries are redacted when they are recorded, so this can only ever return redacted data. */
apiRouter.get("/api/wirelog", (req, res) => {
  res.json({ entries: listEntries(Number(req.query.since) || 0), latestId: nextEntryId() - 1 });
});

apiRouter.delete("/api/wirelog", (_req, res) => {
  clearEntries();
  res.json({ ok: true });
});

function recordDataRequest(req: Request, step: string): void {
  const notes = ["The browser asks the Node server. It sends no token and no patient ID, only its session cookie."];
  if (req.query.patient !== undefined) {
    notes.push(`Ignored browser-supplied ?patient=${String(req.query.patient)}. The patient comes from the token context.`);
  }
  record({ direction: "browser-client", step, method: "GET", endpoint: req.path, outcome: "info", notes });
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
