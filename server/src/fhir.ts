import axios from "axios";
import type { SessionData } from "express-session";
import { refreshAccessToken } from "./oauth.js";
import type { AuthorizedContext } from "./session.js";
import { record, startTimer } from "./wireLog.js";

type SessionState = Partial<SessionData>;

/** The access token was rejected and could not be renewed: the user must connect again. */
export class ReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

export class MissingPatientContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingPatientContextError";
  }
}

export class FhirRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "FhirRequestError";
  }
}

interface FhirResponse {
  status: number;
  url: string;
  data: unknown;
}

/**
 * THE central FHIR request wrapper. Every outbound FHIR call goes through here.
 *
 *   FHIR request → 401 Unauthorized → refresh token → new access token → retry FHIR request → success
 *
 * At most: the original request + one refresh + one retry. No loops.
 * `trace` collects a short, credential-free summary of each step (used by the token-expiry demo).
 */
export async function fhirGet(session: SessionState, path: string, step: string, trace: string[] = []): Promise<unknown> {
  if (!session.auth) throw new ReauthRequiredError("Not connected. Click Connect to authorize.");

  const first = await sendWithAccessToken(session.auth, path, step, "Original request.");
  trace.push(`FHIR request → HTTP ${first.status}`);
  if (first.status !== 401) return dataOrThrow(first);

  // 401: the FHIR server rejected the access token. Try ONE refresh.
  const refreshed = await refreshAccessToken(
    session,
    "The FHIR server answered 401 Unauthorized. The FHIR wrapper makes ONE refresh attempt, then ONE retry.",
  );
  trace.push(refreshed ? "Refresh token → new access token" : "Refresh failed");
  if (!refreshed || !session.auth) {
    // Unusable credentials are discarded. The UI asks the user to reconnect.
    delete session.auth;
    recordReauthRequired("The access token was rejected and could not be refreshed.");
    throw new ReauthRequiredError(
      "The FHIR server rejected the access token and it could not be refreshed. Please reconnect.",
    );
  }

  // Retry the original request exactly once, with the new access token.
  const retry = await sendWithAccessToken(session.auth, path, step, "Retry with the refreshed access token (once, no more).");
  trace.push(`FHIR retry → HTTP ${retry.status}`);
  if (retry.status === 401) {
    delete session.auth;
    recordReauthRequired("The refreshed access token was rejected too. No further retries.");
    throw new ReauthRequiredError("The FHIR server rejected the refreshed access token too. Please reconnect.");
  }
  return dataOrThrow(retry);
}

async function sendWithAccessToken(auth: AuthorizedContext, path: string, step: string, note: string): Promise<FhirResponse> {
  const url = `${auth.fhirBaseUrl}/${path}`;
  const headers = { Accept: "application/fhir+json", Authorization: `Bearer ${auth.accessToken}` };
  const stop = startTimer();
  const response = await axios.get(url, { headers, timeout: 20_000, validateStatus: () => true });

  const [endpoint, query = ""] = url.split("?");
  record({
    direction: "client-fhir",
    step,
    method: "GET",
    endpoint,
    params: { ...Object.fromEntries(new URLSearchParams(query)), Authorization: headers.Authorization },
    status: response.status,
    durationMs: stop(),
    result: summarizeFhirResponse(response.data),
    outcome: response.status < 400 ? "ok" : "error",
    notes: [
      note,
      "Back channel: the Node server calls the FHIR server with the access token. The browser never does.",
    ],
  });
  return { status: response.status, url, data: response.data };
}

function recordReauthRequired(reason: string): void {
  record({
    direction: "internal",
    step: "Re-authentication required",
    outcome: "error",
    notes: [reason, "The stored tokens were discarded. The user must click Connect again."],
  });
}

function dataOrThrow(response: FhirResponse): unknown {
  if (response.status >= 200 && response.status < 300) return response.data;
  throw new FhirRequestError(`The FHIR server returned HTTP ${response.status}.`, response.status, response.url);
}

/** A short description of a FHIR response for the wire log (never the full clinical payload). */
function summarizeFhirResponse(data: unknown): unknown {
  if (typeof data === "string") return data.slice(0, 300);
  if (typeof data !== "object" || data === null) return data;
  const resource = data as Record<string, any>;
  if (resource.resourceType === "Bundle") {
    return {
      resourceType: "Bundle",
      total: resource.total,
      entriesReturned: Array.isArray(resource.entry) ? resource.entry.length : 0,
      hasNextPage: Array.isArray(resource.link) && resource.link.some((link: any) => link.relation === "next"),
    };
  }
  if (resource.resourceType === "OperationOutcome") {
    return {
      resourceType: "OperationOutcome",
      issues: (resource.issue ?? []).map((issue: any) => ({ severity: issue.severity, diagnostics: issue.diagnostics })),
    };
  }
  return { resourceType: resource.resourceType, id: resource.id };
}

// ---------------------------------------------------------------------------
// Patient and labs. The patient ID always comes from the token context.
// ---------------------------------------------------------------------------

interface CodeableConcept {
  text?: string;
  coding?: { code?: string; display?: string }[];
}

interface FhirPatient {
  resourceType?: string;
  id?: string;
  name?: { text?: string; given?: string[]; family?: string }[];
  gender?: string;
  birthDate?: string;
}

interface FhirObservation {
  resourceType: "Observation";
  id?: string;
  code?: CodeableConcept;
  valueQuantity?: { value?: number; comparator?: string; unit?: string; code?: string };
  valueString?: string;
  valueCodeableConcept?: CodeableConcept;
  valueBoolean?: boolean;
  valueInteger?: number;
  effectiveDateTime?: string;
  effectiveInstant?: string;
  effectivePeriod?: { start?: string };
  issued?: string;
  interpretation?: CodeableConcept[];
}

interface FhirBundle {
  total?: number;
  entry?: { resource?: { resourceType?: string } }[];
  link?: { relation?: string }[];
}

export interface PatientSummary {
  id: string;
  name: string | null;
  gender: string | null;
  birthDate: string | null;
}

export interface LabRow {
  id: string | null;
  code: string | null;
  /** null means the Observation has no usable value. The UI shows "Missing"; we never guess. */
  value: string | null;
  unit: string | null;
  date: string | null;
  interpretation: string | null;
}

export interface LabResults {
  rows: LabRow[];
  total: number | null;
  hasMorePages: boolean;
}

/** The server decides which patient is authorized: the one in the token response's launch context. */
function authorizedPatientId(session: SessionState): string {
  if (!session.auth) throw new ReauthRequiredError("Not connected. Click Connect to authorize.");
  if (!session.auth.patientId) {
    throw new MissingPatientContextError(
      "The token response contained no patient context (was launch/patient granted?). This app will not guess a patient.",
    );
  }
  return session.auth.patientId;
}

export async function getAuthorizedPatient(session: SessionState, trace?: string[]): Promise<PatientSummary> {
  const patientId = authorizedPatientId(session);
  const patient = (await fhirGet(
    session,
    `Patient/${encodeURIComponent(patientId)}`,
    "FHIR API call: Patient",
    trace,
  )) as FhirPatient;
  return {
    id: patient.id ?? patientId,
    name: patientName(patient),
    gender: patient.gender ?? null,
    birthDate: patient.birthDate ?? null,
  };
}

export async function getLabs(session: SessionState): Promise<LabResults> {
  const patientId = authorizedPatientId(session);
  const query = new URLSearchParams({ patient: patientId, category: "laboratory" });
  const bundle = (await fhirGet(session, `Observation?${query}`, "FHIR API call: laboratory Observations")) as FhirBundle;

  const rows = (bundle.entry ?? [])
    .map((entry) => entry.resource)
    .filter((resource): resource is FhirObservation => resource?.resourceType === "Observation")
    .map(flattenObservation)
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

  return {
    rows,
    total: typeof bundle.total === "number" ? bundle.total : null,
    // Only the first page is shown. A production app would follow "next" links.
    hasMorePages: Boolean(bundle.link?.some((link) => link.relation === "next")),
  };
}

export function flattenObservation(observation: FhirObservation): LabRow {
  return {
    id: observation.id ?? null,
    code: conceptText(observation.code),
    value: observationValue(observation),
    unit: observation.valueQuantity?.unit ?? observation.valueQuantity?.code ?? null,
    date:
      observation.effectiveDateTime ??
      observation.effectiveInstant ??
      observation.effectivePeriod?.start ??
      observation.issued ??
      null,
    interpretation:
      (observation.interpretation ?? [])
        .map(conceptText)
        .filter((text): text is string => Boolean(text))
        .join(", ") || null,
  };
}

function observationValue(observation: FhirObservation): string | null {
  const quantity = observation.valueQuantity;
  if (quantity && typeof quantity.value === "number") return `${quantity.comparator ?? ""}${quantity.value}`;
  if (typeof observation.valueString === "string") return observation.valueString;
  if (observation.valueCodeableConcept) return conceptText(observation.valueCodeableConcept);
  if (typeof observation.valueBoolean === "boolean") return String(observation.valueBoolean);
  if (typeof observation.valueInteger === "number") return String(observation.valueInteger);
  // Ranges, ratios, components, dataAbsentReason…: reported as missing, never guessed.
  return null;
}

function conceptText(concept: CodeableConcept | undefined): string | null {
  if (!concept) return null;
  const coding = concept.coding?.find((item) => item.display || item.code);
  return concept.text ?? coding?.display ?? coding?.code ?? null;
}

function patientName(patient: FhirPatient): string | null {
  const name = patient.name?.[0];
  if (!name) return null;
  return name.text ?? ([...(name.given ?? []), name.family].filter(Boolean).join(" ") || null);
}
