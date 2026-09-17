import type { DiscoveryInfo, TeachingError } from "../types";
import { ErrorNotice } from "./ErrorNotice";

interface Props {
  discovery: DiscoveryInfo | null;
  error: TeachingError | null;
  onRefresh: () => void;
}

export function DiscoveryPanel({ discovery, error, onRefresh }: Props) {
  const requested = discovery?.requestedScope.split(" ") ?? [];

  return (
    <section className="section">
      <div className="section-head">
        <h2>SMART discovery</h2>
        <button type="button" className="button small" onClick={onRefresh}>
          Fetch again
        </button>
      </div>

      {error && <ErrorNotice error={error} />}
      {!discovery && !error && <p className="absent">Loading the discovery document…</p>}

      {discovery && (
        <>
          <p className="lede discovery-request">
            GET <Endpoint url={discovery.url} />
          </p>
          <dl className="discovery-fields">
            <Field name="authorization_endpoint" value={discovery.authorization_endpoint} />
            <Field name="token_endpoint" value={discovery.token_endpoint} />
            <div>
              <dt>code_challenge_methods_supported</dt>
              <dd>
                <ValueList values={discovery.code_challenge_methods_supported} emphasize={["S256"]} />
              </dd>
            </div>
            <div>
              <dt>scopes_supported</dt>
              <dd>
                <ValueList values={discovery.scopes_supported} emphasize={requested} />
              </dd>
            </div>
            <div>
              <dt>capabilities</dt>
              <dd>
                <ValueList values={discovery.capabilities} />
              </dd>
            </div>
          </dl>

          {discovery.warnings.length > 0 && (
            <ul className="warnings">
              {discovery.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}

          {discovery.unadvertisedScopes && discovery.unadvertisedScopes.length > 0 && (
            <p className="lede">
              Requested but not listed in scopes_supported:{" "}
              {discovery.unadvertisedScopes.map((scope) => (
                <code key={scope} className="inline-scope">
                  {scope}
                </code>
              ))}
              . The list does not have to be complete; compare with the granted scope after connecting.
            </p>
          )}

          <details>
            <summary>Full discovery document</summary>
            <pre className="raw">{JSON.stringify(discovery.document, null, 2)}</pre>
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
