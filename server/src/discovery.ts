import axios from "axios";
import { safeHeaders } from "./safeView.js";
import type { EventDetail } from "./timeline.js";
import { record, startTimer } from "./wireLog.js";

/** What this client reads from GET {fhirBaseUrl}/.well-known/smart-configuration */
export interface Discovery {
  fhirBaseUrl: string;
  url: string;
  fetchedAt: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  scopesSupported?: string[];
  codeChallengeMethodsSupported?: string[];
  capabilities?: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  warnings: string[];
  document: Record<string, unknown>;
}

export class DiscoveryError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DiscoveryError";
  }
}

// One cached document per FHIR base URL: the configured sandbox and each EHR-launch iss get their own.
const cache = new Map<string, Discovery>();

export interface DiscoverOptions {
  force?: boolean;
  /** Runs after the request is built and before it is sent: the protocol debugger pauses here. */
  beforeSend?: (request: { url: string; headers: Record<string, string> }) => Promise<unknown>;
}

export async function discover(fhirBaseUrl: string, options: DiscoverOptions = {}): Promise<Discovery> {
  const cached = cache.get(fhirBaseUrl);
  if (cached && !options.force) return cached;

  const url = `${fhirBaseUrl}/.well-known/smart-configuration`;
  const requestHeaders = { Accept: "application/json" };
  await options.beforeSend?.({ url, headers: requestHeaders });
  const logged = {
    direction: "client-fhir",
    category: "discovery",
    step: "SMART discovery",
    method: "GET",
    endpoint: url,
    requestHeaders,
    why: "The client learns its authorization and token endpoints from the FHIR server itself, so nothing is hardcoded.",
    security:
      "Public metadata: no credential is sent or received. Trusting the wrong discovery document would send users to the wrong login page, which is why the FHIR base URL is configuration.",
  } as const;
  const failed = [{ step: "discovery", status: "failed" }] as const;
  const stop = startTimer();
  const response = await axios
    .get(url, { headers: requestHeaders, timeout: 15_000, validateStatus: () => true })
    .catch((error: Error) => {
      record({
        ...logged,
        timeline: [...failed],
        status: "network error",
        durationMs: stop(),
        result: { message: error.message },
        outcome: "error",
      });
      throw new DiscoveryError(`Could not reach ${url}: ${error.message}`, url);
    });

  if (response.status !== 200 || !isObject(response.data)) {
    const body = typeof response.data === "string" ? response.data.slice(0, 300) : response.data;
    record({
      ...logged,
      timeline: [...failed],
      status: response.status,
      responseHeaders: safeHeaders(response.headers),
      durationMs: stop(),
      result: body,
      outcome: "error",
    });
    throw new DiscoveryError(`SMART discovery failed: HTTP ${response.status} from ${url}`, url, response.status);
  }

  const discovery = readDiscoveryDocument(fhirBaseUrl, url, response.data);
  record({
    ...logged,
    timeline: [{ step: "discovery", status: "done" }],
    detail: describeDiscovery(discovery, "fetched"),
    status: response.status,
    responseHeaders: safeHeaders(response.headers),
    durationMs: stop(),
    result: {
      authorization_endpoint: discovery.authorizationEndpoint,
      token_endpoint: discovery.tokenEndpoint,
      scopes_supported: discovery.scopesSupported,
      code_challenge_methods_supported: discovery.codeChallengeMethodsSupported,
      capabilities: discovery.capabilities,
    },
    outcome: "ok",
    notes: ["The client reads its OAuth endpoints from this document instead of hardcoding them.", ...discovery.warnings],
  });
  cache.set(fhirBaseUrl, discovery);
  return discovery;
}

export function describeDiscovery(discovery: Discovery, source: "fetched" | "cached"): EventDetail {
  return {
    kind: "discovery",
    source,
    fetchedAt: discovery.fetchedAt,
    authorizationEndpoint: discovery.authorizationEndpoint ?? null,
    tokenEndpoint: discovery.tokenEndpoint ?? null,
    codeChallengeMethods: discovery.codeChallengeMethodsSupported ?? null,
  };
}

/** Endpoints come from the discovery document. They are never hardcoded. */
export function requireOAuthEndpoints(discovery: Discovery): { authorizationEndpoint: string; tokenEndpoint: string } {
  if (!discovery.authorizationEndpoint || !discovery.tokenEndpoint) {
    throw new DiscoveryError(
      `The SMART configuration at ${discovery.url} does not include both authorization_endpoint and token_endpoint.`,
      discovery.url,
    );
  }
  return { authorizationEndpoint: discovery.authorizationEndpoint, tokenEndpoint: discovery.tokenEndpoint };
}

function readDiscoveryDocument(fhirBaseUrl: string, url: string, document: Record<string, unknown>): Discovery {
  const discovery: Discovery = {
    fhirBaseUrl,
    url,
    fetchedAt: new Date().toISOString(),
    authorizationEndpoint: stringField(document, "authorization_endpoint"),
    tokenEndpoint: stringField(document, "token_endpoint"),
    scopesSupported: stringArrayField(document, "scopes_supported"),
    codeChallengeMethodsSupported: stringArrayField(document, "code_challenge_methods_supported"),
    capabilities: stringArrayField(document, "capabilities"),
    tokenEndpointAuthMethodsSupported: stringArrayField(document, "token_endpoint_auth_methods_supported"),
    warnings: [],
    document,
  };

  // Absent values are reported, not guessed.
  const { warnings } = discovery;
  if (!discovery.authorizationEndpoint) {
    warnings.push("authorization_endpoint is missing: this client cannot start an authorization request.");
  }
  if (!discovery.tokenEndpoint) {
    warnings.push("token_endpoint is missing: this client cannot exchange an authorization code.");
  }
  if (!discovery.codeChallengeMethodsSupported) {
    warnings.push("code_challenge_methods_supported is not advertised. This client still sends PKCE with S256.");
  } else if (!discovery.codeChallengeMethodsSupported.includes("S256")) {
    warnings.push(
      `code_challenge_methods_supported does not list S256. This client still sends S256 and the server may reject it.`,
    );
  }
  if (!discovery.scopesSupported) {
    warnings.push("scopes_supported is not advertised, so requested scopes cannot be compared with it.");
  }
  if (!discovery.capabilities) {
    warnings.push("capabilities is not advertised.");
  }
  return discovery;
}

function stringField(document: Record<string, unknown>, name: string): string | undefined {
  const value = document[name];
  return typeof value === "string" && value ? value : undefined;
}

function stringArrayField(document: Record<string, unknown>, name: string): string[] | undefined {
  const value = document[name];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
