import dotenv from "dotenv";

dotenv.config({ quiet: true });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing environment variable ${name}. Run "cp .env.example .env" and try again.`);
  }
  return value;
}

export const config = {
  /** Configuration, not proof of capability: what the server supports comes from discovery. */
  fhirBaseUrl: required("FHIR_BASE_URL").replace(/\/+$/, ""),
  clientId: required("CLIENT_ID"),
  /** Only for confidential clients. Used by the Node server only; never sent to the browser. */
  clientSecret: process.env.CLIENT_SECRET?.trim() || undefined,
  redirectUri: required("REDIRECT_URI"),
  scopes: required("SCOPES").split(/\s+/).filter(Boolean).join(" "),
  port: Number(process.env.PORT || 3001),
  sessionSecret: required("SESSION_SECRET"),
  clientUrl: (process.env.CLIENT_URL?.trim() || "http://localhost:5173").replace(/\/+$/, ""),
};

if (config.sessionSecret === "replace-me") {
  console.warn('SESSION_SECRET is still "replace-me". Fine for a local demo; never in production.');
}
