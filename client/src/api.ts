import type {
  DemoResult,
  DiscoveryInfo,
  LabResults,
  PatientSummary,
  SessionInfo,
  TeachingError,
  WireEntry,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly teaching: TeachingError,
  ) {
    super(teaching.message);
  }
}

// The browser only ever sends its httpOnly session cookie. It never holds a token.
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "same-origin", ...init });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(response.status, body?.error ?? { step: "Request", message: `HTTP ${response.status} from ${path}` });
  }
  return body as T;
}

export const api = {
  session: () => call<SessionInfo>("/api/session"),
  discovery: () => call<DiscoveryInfo>("/api/discovery"),
  refreshDiscovery: () => call<DiscoveryInfo>("/api/discovery/refresh", { method: "POST" }),
  patient: () => call<{ patient: PatientSummary }>("/api/patient"),
  labs: () => call<LabResults>("/api/labs"),
  markRendered: () => call<{ ok: boolean }>("/api/flow/rendered", { method: "POST" }),
  wireLog: (sinceId: number) => call<{ entries: WireEntry[]; latestId: number }>(`/api/wirelog?since=${sinceId}`),
  clearWireLog: () => call<{ ok: boolean }>("/api/wirelog", { method: "DELETE" }),
  logout: () => call<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  forceTokenExpiry: () => call<{ demo: DemoResult }>("/demo/force-expiry", { method: "POST" }),
};

/** Full-page navigation: these flows leave the app and pass through the authorization server. */
export function navigateTo(path: string): void {
  window.location.assign(path);
}

export function toTeachingError(error: unknown): TeachingError {
  if (error instanceof ApiError) return error.teaching;
  return { step: "Request", message: error instanceof Error ? error.message : String(error) };
}
