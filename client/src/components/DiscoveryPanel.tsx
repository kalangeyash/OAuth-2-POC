import type { DiscoveryInfo, Load } from "../types";
import { ErrorNotice } from "./ErrorNotice";

interface Props {
  discovery: Load<DiscoveryInfo>;
  refreshing: boolean;
  onRefresh: () => void;
}

export function DiscoveryPanel({ discovery, refreshing, onRefresh }: Props) {
  // Keep the last good document on screen while refetching: a presenter mid-sentence
  // must not lose the endpoint they are pointing at.
  const shown = discovery.state === "ready" ? discovery.data : null;
  const requested = shown?.requestedScope.split(" ") ?? [];

  return (
    <section className="section" aria-busy={refreshing || discovery.state === "loading" || undefined}>
      <div className="section-head">
        <h2>SMART discovery</h2>
        <button type="button" className="button small" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Fetching…" : "Fetch again"}
        </button>
      </div>

      {discovery.state === "error" && <ErrorNotice error={discovery.error} onRetry={onRefresh} />}
      {discovery.state === "loading" && (
        <p className="absent">Reading .well-known/smart-configuration from the FHIR server…</p>
      )}

      {shown && (
        <>
          <p className="lede discovery-request">
            GET <Endpoint url={shown.url} />
          </p>
          <p className="discovery-meta">
            Fetched {new Date(shown.fetchedAt).toLocaleTimeString([], { hour12: false })}. Nothing below is hardcoded:
            every endpoint was read from this document.
          </p>
          <dl className="discovery-fields">
            <Field name="authorization_endpoint" value={shown.authorization_endpoint} />
            <Field name="token_endpoint" value={shown.token_endpoint} />
            <div>
              <dt>code_challenge_methods_supported</dt>
              <dd>
                <ValueList values={shown.code_challenge_methods_supported} emphasize={["S256"]} />
              </dd>
            </div>
            <div>
              <dt>scopes_supported</dt>
              <dd>
                <ValueList values={shown.scopes_supported} emphasize={requested} />
              </dd>
            </div>
            <div>
              <dt>capabilities</dt>
              <dd>
                <ValueList values={shown.capabilities} />
              </dd>
            </div>
          </dl>

          {shown.warnings.length > 0 && (
            <ul className="warnings">
              {shown.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}

          {shown.unadvertisedScopes && shown.unadvertisedScopes.length > 0 && (
            <p className="lede">
              Requested but not listed in scopes_supported:{" "}
              {shown.unadvertisedScopes.map((scope) => (
                <code key={scope} className="inline-scope">
                  {scope}
                </code>
              ))}
              . The list does not have to be complete; compare with the granted scope after connecting.
            </p>
          )}

          <details>
            <summary>Full discovery document</summary>
            <pre className="raw">{JSON.stringify(shown.document, null, 2)}</pre>
          </details>
        </>
      )}
    </section>
  );
}

function Field({ name, value }: { name: string; value: string | null }) {
  return (
    <div>
      <dt>{name}</dt>
      <dd>{value ? <Endpoint url={value} /> : <span className="absent">Not advertised</span>}</dd>
    </div>
  );
}

/** One line per URL: the long base shortens with an ellipsis, the meaningful path stays bold. Full URL on hover. */
function Endpoint({ url }: { url: string }) {
  const marker = url.search(/\/(auth|fhir)\//i);
  const splitAt = marker >= 0 ? marker : url.lastIndexOf("/");
  return (
    <code className="endpoint" title={url}>
      <span className="endpoint-base">{url.slice(0, splitAt)}</span>
      <span className="endpoint-path">{url.slice(splitAt)}</span>
    </code>
  );
}

function ValueList({ values, emphasize = [] }: { values: string[] | null; emphasize?: string[] }) {
  if (!values) return <span className="absent">Not advertised</span>;
  if (values.length === 0) return <span className="absent">Empty list</span>;
  return (
    <ul className="chips">
      {values.map((value) => (
        <li key={value} className={emphasize.includes(value) ? "chip chip-strong" : "chip"}>
          {value}
        </li>
      ))}
    </ul>
  );
}
