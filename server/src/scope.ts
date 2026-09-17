/** Splits a space-delimited OAuth scope string into unique scopes, keeping their order. */
export function parseScope(scope: string | undefined | null): string[] {
  return [...new Set((scope ?? "").split(/\s+/).filter(Boolean))];
}

export interface ScopeRow {
  scope: string;
  requested: boolean;
  granted: boolean;
}

export interface ScopeDiff {
  requested: string[];
  granted: string[];
  rows: ScopeRow[];
  /** Requested but not granted. */
  dropped: string[];
  /** Granted without being requested. */
  added: string[];
  identical: boolean;
  /** false when the token response had no scope parameter, so the grant is unknown. */
  grantedReported: boolean;
}

/** Requested permissions are not necessarily granted permissions. */
export function diffScopes(requestedScope: string, grantedScope: string | undefined): ScopeDiff {
  const requested = parseScope(requestedScope);
  const grantedReported = typeof grantedScope === "string";
  const granted = parseScope(grantedScope);
  const dropped = grantedReported ? requested.filter((scope) => !granted.includes(scope)) : [];
  const added = granted.filter((scope) => !requested.includes(scope));
  const rows: ScopeRow[] = [
    ...requested.map((scope) => ({ scope, requested: true, granted: granted.includes(scope) })),
    ...added.map((scope) => ({ scope, requested: false, granted: true })),
  ];
  return {
    requested,
    granted,
    rows,
    dropped,
    added,
    grantedReported,
    identical: grantedReported && dropped.length === 0 && added.length === 0,
  };
}

/** Requested scopes missing from scopes_supported. Informational: servers may accept scopes they do not list. */
export function unadvertisedScopes(requestedScope: string, scopesSupported: string[] | undefined): string[] | null {
  if (!scopesSupported) return null;
  return parseScope(requestedScope).filter((scope) => !scopesSupported.includes(scope));
}

/** Demo: replace the resource-specific patient read scopes (patient/Patient.read …) with patient/*.read. */
export function broadenPatientScopes(scope: string): string {
  const narrowRead = /^patient\/[A-Za-z]+\.read$/;
  let replaced = false;
  const broad = parseScope(scope).flatMap((item) => {
    if (!narrowRead.test(item)) return [item];
    if (replaced) return [];
    replaced = true;
    return ["patient/*.read"];
  });
  return (replaced ? broad : [...broad, "patient/*.read"]).join(" ");
}

/** An EHR launch needs the "launch" scope so the authorization server accepts the launch context. */
export function ensureLaunchScope(scope: string): string {
  const scopes = parseScope(scope);
  return (scopes.includes("launch") ? scopes : [...scopes, "launch"]).join(" ");
}
