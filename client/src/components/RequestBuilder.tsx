import { useState } from "react";
import { BUILDER_MODS, type BuilderModId } from "../../../server/src/timeline";
import { glossaryFor } from "../glossary";
import { modificationOf, type FlowModel } from "../model";
import { usePresenter } from "../presenter";
import type { SessionInfo } from "../types";
import { PanelHead, Term, Value } from "./bits";

/*
 * AUTHORIZATION REQUEST BUILDER. The authorization URL, one field at a time:
 * what it is, whether it is required or secret, what it protects, and what
 * happens if it changes. Whitelisted changes can be applied and the REAL request
 * sent (GET /lab/authorize?mods=…), so the audience sees the real server's answer.
 */

const FIELDS = ["response_type", "client_id", "redirect_uri", "scope", "state", "aud", "code_challenge", "code_challenge_method"];

interface Props {
  model: FlowModel;
  session: SessionInfo | null;
  onGenerate: (mods: BuilderModId[]) => void;
  busy: boolean;
}

export function RequestBuilder({ model, session, onGenerate, busy }: Props) {
  const { select } = usePresenter();
  const [mods, setMods] = useState<BuilderModId[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const built = model.inspector;
  const builderChanges = model.modifications.filter((entry) => entry.injection && entry.injection.id in BUILDER_MODS);

  const valueOf = (field: string): string => {
    if (built && field in built.params) return built.params[field];
    if (built) return "(omitted from this request)";
    switch (field) {
      case "response_type":
        return "code";
      case "client_id":
        return "(CLIENT_ID from configuration)";
      case "redirect_uri":
        return "(REDIRECT_URI from configuration)";
      case "scope":
        return session?.requestedScope ?? "(SCOPES from configuration)";
      case "state":
        return "(32 random bytes, generated when the request is built)";
      case "aud":
        return session?.fhirBaseUrl ?? "(the FHIR base URL)";
      case "code_challenge":
        return "(SHA-256 of a fresh code_verifier, generated when the request is built)";
      case "code_challenge_method":
        return "S256";
      default:
        return "";
    }
  };

  return (
    <section className="builder" aria-label="Authorization Request Builder">
      <PanelHead
        title="Authorization Request Builder"
        note={
          built
            ? `The authorization request the backend actually built in this run (#${built.entry.id}). Click a field to explain it.`
            : "No authorization request built in this run yet. The values below show what will be generated."
        }
      >
        {built && (
          <button type="button" className="button small" onClick={() => select(built.entry.id)}>
            Inspect #{built.entry.id}
          </button>
        )}
      </PanelHead>

      {built && (
        <pre className="url-breakdown" aria-label="Authorization URL">
          <span className="url-endpoint">GET {built.endpoint}</span>
          {Object.entries(built.params).map(([key, value], index) => (
            <span key={key} className={builderChanges.some((entry) => modificationOf(entry)?.field.startsWith(key)) ? "url-param is-modified" : "url-param"}>
              {"\n  "}
              {index === 0 ? "?" : "&"}
              {key}={value}
            </span>
          ))}
        </pre>
      )}

      <table className="builder-table">
        <thead>
          <tr>
            <th scope="col">Parameter</th>
            <th scope="col">Value</th>
            <th scope="col">Required</th>
            <th scope="col">Explanation</th>
          </tr>
        </thead>
        <tbody>
          {FIELDS.map((field) => {
            const glossary = glossaryFor(field);
            const changed = builderChanges.find((entry) => modificationOf(entry)?.field.startsWith(field));
            const isOpen = open === field;
            return (
              <tr key={field} className={changed ? "is-modified" : undefined}>
                <th scope="row">
                  <Term name={field} />
                </th>
                <td className="builder-value">
                  <Value value={valueOf(field)} />
                  {changed && (
                    <span className="modified-note">
                      changed: {modificationOf(changed)?.original} → {modificationOf(changed)?.sent}
                    </span>
                  )}
                </td>
                <td>{glossary?.required ?? "—"}</td>
                <td>
                  {glossary?.what}
                  <button type="button" className="link-button" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : field)}>
                    {isOpen ? "less" : "security impact"}
                  </button>
                  {isOpen && glossary && (
                    <dl className="facts-list compact">
                      <div>
                        <dt>Secret?</dt>
                        <dd>{glossary.secret}</dd>
                      </div>
                      <div>
                        <dt>Protects against</dt>
                        <dd>{glossary.protects}</dd>
                      </div>
                      <div>
                        <dt>If changed</dt>
                        <dd>{glossary.ifModified}</dd>
                      </div>
                      <div>
                        <dt>Validated later?</dt>
                        <dd>{glossary.consumedBy}</dd>
                      </div>
                    </dl>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <fieldset className="mods">
        <legend>Controlled modifications (whitelisted, real requests)</legend>
        {(Object.keys(BUILDER_MODS) as BuilderModId[]).map((id) => (
          <label key={id} className="mod">
            <input
              type="checkbox"
              checked={mods.includes(id)}
              onChange={(event) => setMods(event.target.checked ? [...mods, id] : mods.filter((mod) => mod !== id))}
            />
            <span>
              <strong>{BUILDER_MODS[id].label}</strong> <code>{BUILDER_MODS[id].field}</code>
              <span className="mod-effect">{BUILDER_MODS[id].effect}</span>
              <span className="mod-expect">Expect: {BUILDER_MODS[id].expect}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="builder-actions">
        <button type="button" className="button primary" disabled={busy} onClick={() => onGenerate(mods)}>
          Generate authorization request{mods.length > 0 ? ` with ${mods.length} change${mods.length === 1 ? "" : "s"}` : ""}
        </button>
        <p className="lede">
          Sends the browser (or popup) to <code>/lab/authorize</code>. Combine with <strong>Step through every stage</strong> to see each
          value built before it is sent.
        </p>
      </div>
    </section>
  );
}
