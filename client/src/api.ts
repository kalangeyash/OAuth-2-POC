import type {
  DemoId,
  DemoResult,
  InjectionId,
  LabMode,
  LabState,
  DiscoveryInfo,
  LabResults,
  PatientSummary,
  SessionInfo,
  TeachingError,
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
  /**
   * browserPatientId exists only for the "try another patient" demonstration:
   * the server ignores it and uses the patient from the token context.
   */
  patient: (browserPatientId?: string) =>
    call<{ patient: PatientSummary }>(
      browserPatientId === undefined ? "/api/patient" : `/api/patient?patient=${encodeURIComponent(browserPatientId)}`,
    ),
  labs: () => call<LabResults>("/api/labs"),
  markRendered: () => call<{ ok: boolean }>("/api/flow/rendered", { method: "POST" }),
  logout: () => call<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  /** The token-lifecycle scenarios that run inside the current session (no redirect). */
  runPostDemo: (demo: DemoId) => call<{ demo: DemoResult }>(`/demo/${demo}`, { method: "POST" }),

  // The protocol debugger (server/src/lab.ts)
  labMode: (mode: LabMode) => call<LabState>("/api/lab/mode", json({ mode })),
  labDecide: (breakpointId: number, action: "send" | "run" | "abort", inject?: InjectionId) =>
    call<{ accepted: boolean; state: LabState }>("/api/lab/decide", json({ breakpointId, action, inject: inject ?? null })),
  labReset: (clearLog: boolean) => call<LabState>("/api/lab/reset", json({ clearLog })),
};

function json(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** Full-page navigation: these flows leave the app and pass through the authorization server. */
export function navigateTo(path: string): void {
  window.location.assign(path);
}

/** The popup's window name. main.tsx recognises it and closes the popup once the flow returns. */
export const AUTH_POPUP_NAME = "smart-oauth-flow";

/**
 * Starts an authorization (Connect, Reconnect, a redirect demo).
 *
 * In popup mode the login and consent pages open in a small window, so this
 * dashboard stays on screen and shows every event live. If the browser blocks
 * the popup, it falls back to the ordinary same-window redirect.
 */
export function startAuthorizationFlow(path: string, popupMode: boolean): Window | null {
  if (popupMode) {
    const width = 540;
    const height = 780;
    const left = Math.max(0, window.screenX + window.outerWidth - width - 40);
    const top = Math.max(0, window.screenY + 60);
    const popup = window.open(path, AUTH_POPUP_NAME, `popup,width=${width},height=${height},left=${left},top=${top}`);
    if (popup) {
      popup.focus();
      return popup;
    }
  }
  navigateTo(path);
  return null;
}

export function toTeachingError(error: unknown): TeachingError {
  if (error instanceof ApiError) return error.teaching;
  return { step: "Request", message: error instanceof Error ? error.message : String(error) };
}
