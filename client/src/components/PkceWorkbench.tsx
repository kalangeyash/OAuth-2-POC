import { useEffect, useState } from "react";
import type { FlowModel, Stage } from "../model";
import { usePresenter } from "../presenter";
import { Chain, PanelHead, Term } from "./bits";

/*
 * PKCE CRYPTOGRAPHY WORKBENCH.
 *
 *  1. Real runtime values from THIS run: the verifier by length and fingerprint
 *     only, the (public) challenge, where each is stored and when each is sent,
 *     and the authorization server's real verdict.
 *  2. An illustrative workbench: SHA-256 and base64url computed in this browser
 *     (WebCrypto) on a SYNTHETIC verifier. Clearly labelled; never used by the flow.
 */

const RFC_7636_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

interface Props {
  model: FlowModel;
  onRunScenario: () => void;
  onStepAndAlter: () => void;
}

export function PkceWorkbench({ model, onRunScenario, onStepAndAlter }: Props) {
  const { select } = usePresenter();
  const pkce = model.pkce;
  const challengeInUrl = pkce.authorizationRequest?.params?.code_challenge;
  const methodInUrl = pkce.authorizationRequest?.params?.code_challenge_method;

  const generation: Stage[] = [
    {
      id: "verifier",
      label: "Random code_verifier (stays on the server)",
      actor: "node",
      status: pkce.verifier ? "done" : "pending",
      entryId: pkce.verifier?.entry.id ?? null,
      note: pkce.verifier
        ? `${pkce.verifier.detail.length} chars · ${pkce.verifier.detail.bits} bits of randomness · fingerprint ${pkce.verifier.detail.fingerprint}`
        : null,
    },
    { id: "sha", label: "SHA-256 hash", actor: "node", status: pkce.challenge ? "done" : "pending", entryId: pkce.challenge?.entry.id ?? null, note: null },
    { id: "b64", label: "Base64URL encoding (no padding)", actor: "node", status: pkce.challenge ? "done" : "pending", entryId: null, note: null },
    {
      id: "challenge",
      label: "code_challenge",
      actor: "node",
      status: pkce.challenge ? "done" : "pending",
      entryId: pkce.challenge?.entry.id ?? null,
      note: pkce.challenge ? `${pkce.challenge.detail.challenge} (public)` : null,
    },
    {
      id: "sent",
      label: "Sent in the authorization request (front channel)",
      actor: "browser",
      status: pkce.authorizationRequest ? (challengeInUrl ? "done" : "failed") : "pending",
      entryId: pkce.authorizationRequest?.id ?? null,
      note: pkce.authorizationRequest ? (challengeInUrl ? `code_challenge_method=${methodInUrl}` : "code_challenge was OMITTED (builder experiment)") : null,
    },
  ];

  const proof = pkce.proof?.detail;
  const verification: Stage[] = [
    {
      id: "code",
      label: "Authorization code returned",
      actor: "auth",
      status: pkce.callback ? (pkce.callback.detail.hasAuthorizationCode ? "done" : "failed") : "pending",
      entryId: pkce.callback?.entry.id ?? null,
      note: pkce.callback?.detail.authorizationCodePreview ?? null,
    },
    {
      id: "verifier-sent",
      label: "Backend sends code_verifier to the token endpoint",
      actor: "node",
      status: proof ? (proof.verifierSent ? "done" : "failed") : pkce.verdict === "not-reached" ? "not-needed" : "pending",
      entryId: pkce.proof?.entry.id ?? null,
      note: proof
        ? proof.verifierSent
          ? `fingerprint ${proof.verifierFingerprint}${proof.recomputedChallengeMatches ? "" : " — ALTERED"}`
          : "NOT sent (removed on purpose)"
        : pkce.verdict === "not-reached"
          ? "never sent: the flow stopped earlier"
          : null,
    },
    {
      id: "node-check",
      label: "Node's own check: SHA-256(verifier) = code_challenge",
      actor: "node",
      status: proof ? (proof.verifierSent && proof.recomputedChallengeMatches ? "done" : "failed") : "pending",
      entryId: pkce.proof?.entry.id ?? null,
      note: proof ? (proof.recomputedChallengeMatches ? "matches" : "does NOT match") : null,
    },
    {
      id: "server-compare",
      label: "Authorization server hashes the verifier and compares (observed via its response)",
      actor: "auth",
      status: pkce.verdict === "accepted" ? "done" : pkce.verdict === "rejected" ? "failed" : pkce.verdict === "not-reached" ? "not-needed" : "pending",
      entryId: pkce.exchange?.id ?? null,
      note: pkce.exchange ? `HTTP ${pkce.exchange.status}` : null,
    },
    {
      id: "verdict",
      label: "Token exchange accepted or rejected",
      actor: "auth",
      status: pkce.verdict === "accepted" ? "done" : pkce.verdict === "rejected" ? "failed" : pkce.verdict === "not-reached" ? "not-needed" : "pending",
      entryId: pkce.exchange?.id ?? null,
      note:
        pkce.verdict === "accepted"
          ? "ACCEPTED: tokens issued"
          : pkce.verdict === "rejected"
            ? `REJECTED: ${pkce.error?.error ?? ""} ${pkce.error?.description ? `— ${pkce.error.description}` : ""}`
            : null,
    },
  ];

  return (
    <section className="pkce" aria-label="PKCE cryptography workbench">
      <PanelHead title="PKCE cryptography workbench" note="Proof Key for Code Exchange (RFC 7636): the code is bound to a secret only this server holds." />

      <p className="equation">
        BASE64URL( SHA256( <Term name="code_verifier" /> ) ) = <Term name="code_challenge" />
      </p>

      <div className="two-col">
        <div>
          <h3>1 · Generation (this run, real)</h3>
          <Chain stages={generation} label="PKCE generation" />
          <dl className="facts-list compact">
            <div>
              <dt>Verifier stored</dt>
              <dd>Server-side session only (never in the browser, never in a URL)</dd>
            </div>
            <div>
              <dt>Challenge sent</dt>
              <dd>Front channel, in the authorization URL: safe, it is a one-way hash</dd>
            </div>
            <div>
              <dt>Verifier sent</dt>
              <dd>Once, back channel, in the token request</dd>
            </div>
          </dl>
        </div>
        <div>
          <h3>2 · Verification (this run, real)</h3>
          <Chain stages={verification} label="PKCE verification" />
          {pkce.verdict === "rejected" && pkce.exchange && (
            <div className="verdict-box is-rejected">
              <strong>The authorization code could not be redeemed.</strong>
              <p>
                The token endpoint answered HTTP {pkce.exchange.status}
                {pkce.error?.error ? ` ${pkce.error.error}` : ""}
                {pkce.error?.description ? `: “${pkce.error.description}”` : ""}. Without the verifier whose hash matches the challenge, the code
                is worthless to whoever holds it — that is the point of PKCE.
              </p>
              <button type="button" className="link-button" onClick={() => select(pkce.exchange!.id)}>
                Inspect the exact error response
              </button>
            </div>
          )}
        </div>
      </div>

      <IllustrativeWorkbench />

      <div className="experiment">
        <h3>PKCE failure experiment</h3>
        <ol className="experiment-steps">
          <li>Start a valid authorization flow.</li>
          <li>Remove or alter the verifier before the token exchange.</li>
          <li>Watch the real token endpoint's real error, and where the flow stops.</li>
        </ol>
        <div className="builder-actions">
          <button type="button" className="button" onClick={onRunScenario}>
            Run “Missing PKCE verifier”
          </button>
          <button type="button" className="button" onClick={onStepAndAlter}>
            Step through and alter the verifier at the token breakpoint
          </button>
        </div>
      </div>
    </section>
  );
}

function IllustrativeWorkbench() {
  const [verifier, setVerifier] = useState(RFC_7636_VERIFIER);
  const [result, setResult] = useState<{ hex: string; challenge: string } | null>(null);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!window.crypto?.subtle) {
      setUnsupported(true);
      return;
    }
    void (async () => {
      const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
      const bytes = new Uint8Array(digest);
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const challenge = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      if (!cancelled) setResult({ hex, challenge });
    })();
    return () => {
      cancelled = true;
    };
  }, [verifier]);

  const valid = /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier);
  return (
    <div className="illustrative">
      <p className="illustrative-badge">ILLUSTRATIVE VALUES — computed in your browser. Never the real runtime verifier; never sent anywhere.</p>
      <label className="field">
        <span>Synthetic code_verifier (edit it and watch the challenge change)</span>
        <input type="text" value={verifier} spellCheck={false} onChange={(event) => setVerifier(event.target.value)} />
      </label>
      <div className="builder-actions">
        <button type="button" className="button small" onClick={() => setVerifier(randomVerifier())}>
          New random (synthetic) verifier
        </button>
        <button type="button" className="button small" onClick={() => setVerifier(RFC_7636_VERIFIER)}>
          RFC 7636 Appendix B example
        </button>
      </div>
      {!valid && <p className="warning-text">RFC 7636: 43–128 characters from A–Z a–z 0–9 - . _ ~</p>}
      {unsupported ? (
        <p className="absent">This browser does not expose WebCrypto here (it needs localhost or HTTPS).</p>
      ) : (
        <ol className="derivation">
          <li>
            <span className="derivation-label">code_verifier ({verifier.length} chars, ≈{verifier.length * 6} bits if random)</span>
            <code>{verifier}</code>
          </li>
          <li>
            <span className="derivation-label">SHA-256 (32 bytes, hex)</span>
            <code>{result?.hex ?? "…"}</code>
          </li>
          <li>
            <span className="derivation-label">Base64URL, no padding = code_challenge (S256)</span>
            <code className="derivation-result">{result?.challenge ?? "…"}</code>
          </li>
        </ol>
      )}
      {verifier === RFC_7636_VERIFIER && result && (
        <p className="lede">
          {result.challenge === "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" ? "✓ Matches" : "✕ Does not match"} the challenge published in RFC 7636 Appendix B (also checked by server/tests/pkce.test.ts).
        </p>
      )}
    </div>
  );
}

function randomVerifier(): string {
  const bytes = new Uint8Array(48);
  window.crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
