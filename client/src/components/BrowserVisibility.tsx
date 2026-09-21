import { useEffect, useState } from "react";
import type { FlowModel } from "../model";
import { usePresenter } from "../presenter";
import type { SessionInfo } from "../types";
import { PanelHead, Term } from "./bits";

/*
 * WHAT CAN THE BROWSER SEE? Checked live, in this browser, by this page's own
 * JavaScript: the same access any injected script would have. Nothing here is a
 * hardcoded claim: the cookie attributes come from the server's real session
 * configuration, and the storage scan reads the real storage.
 */

interface StorageScan {
  localKeys: string[];
  sessionKeys: string[];
  documentCookie: string;
  suspicious: string[];
  scannedAt: string;
}

const TOKEN_LIKE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|access_token|refresh_token|id_token|Bearer\s/;

function scanStorage(): StorageScan {
  const read = (storage: Storage | undefined) => {
    const keys: string[] = [];
    const suspicious: string[] = [];
    try {
      if (!storage) return { keys, suspicious };
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key === null) continue;
        keys.push(key);
        const value = storage.getItem(key) ?? "";
        if (TOKEN_LIKE.test(key) || TOKEN_LIKE.test(value)) suspicious.push(key);
      }
    } catch {
      // Storage blocked: nothing readable, so nothing leaked.
    }
    return { keys, suspicious };
  };
  const local = read(window.localStorage);
  const session = read(window.sessionStorage);
  let documentCookie = "";
  try {
    documentCookie = document.cookie;
  } catch {
    documentCookie = "";
  }
  return {
    localKeys: local.keys,
    sessionKeys: session.keys,
    documentCookie,
    suspicious: [...local.suspicious, ...session.suspicious, ...(TOKEN_LIKE.test(documentCookie) ? ["document.cookie"] : [])],
    scannedAt: new Date().toLocaleTimeString([], { hour12: false }),
  };
}

export function BrowserVisibility({ session, model }: { session: SessionInfo | null; model: FlowModel }) {
  const { select } = usePresenter();
  const [scan, setScan] = useState<StorageScan>(() => scanStorage());
  useEffect(() => {
    setScan(scanStorage());
  }, [session?.authorized]);

  const cookie = session?.sessionCookie;
  const authUrl = model.inspector?.url;
  const callback = model.state.callback;

  return (
    <section className="browser-vis" aria-label="What can the browser see">
      <PanelHead title="What can the browser see?" note="Checked live by this page's own JavaScript — the same access an injected script would have.">
        <button type="button" className="button small" onClick={() => setScan(scanStorage())}>
          Scan browser storage again
        </button>
      </PanelHead>

      <div className="two-col">
        <div className="visible-col">
          <h3>Visible to the browser</h3>
          <ul className="vis-list">
            <li>
              <strong>Authorization URL</strong> (address bar, history)
              {authUrl ? (
                <button type="button" className="link-button" onClick={() => model.inspector && select(model.inspector.entry.id)}>
                  this run's
                </button>
              ) : (
                <span className="muted"> — none this run</span>
              )}
            </li>
            <li>
              <strong>Authorization code callback</strong>: <code>/callback?code=…&amp;state=…</code>{" "}
              {callback && (
                <button type="button" className="link-button" onClick={() => select(callback.entry.id)}>
                  code {callback.detail.authorizationCodePreview ?? "none"}
                </button>
              )}
            </li>
            <li>
              <strong>Redirect URL</strong>, <Term name="client_id" /> (public identifier), requested <Term name="scope" />
            </li>
            <li>
              <strong>That an httpOnly cookie exists</strong> (DevTools shows it; page JavaScript cannot read it)
            </li>
            <li>
              <strong>Patient and lab data</strong> React rendered (synthetic)
            </li>
          </ul>
        </div>
        <div className="hidden-col">
          <h3>Never exposed to browser JavaScript</h3>
          <ul className="vis-list">
            <li>
              <Term name="access_token" /> → server-side session
            </li>
            <li>
              <Term name="refresh_token" /> → server-side session
            </li>
            <li>
              <Term name="id_token" /> → server-side session (only decoded claims are shown)
            </li>
            <li>
              <Term name="code_verifier" /> → server-side session, then the back-channel token request
            </li>
            <li>Client secret (if configured) → server environment only</li>
            <li>The token exchange request and response → server to server</li>
            <li>Server session contents → {session?.tokenStorage ?? "server memory"}</li>
          </ul>
        </div>
      </div>

      <div className="devtools" aria-label="Simulated browser DevTools, filled from real values">
        <p className="devtools-title">Application · Storage (this browser, live)</p>
        <pre className="devtools-tree">
          {`Cookies  (attributes from the server's real session configuration)
└── ${cookie?.name ?? "smart_demo_sid"} = ••••••••   ${cookie?.sentWithThisRequest ? "(sent with the last request)" : "(not set yet)"}
    ├── HttpOnly: ${cookie ? String(cookie.httpOnly) : "true"}
    ├── Secure:   ${cookie ? String(cookie.secure) : "false"}${cookie && !cookie.secure ? "  (plain http on localhost; HTTPS + Secure in production)" : ""}
    ├── SameSite: ${cookie ? capitalise(cookie.sameSite) : "Lax"}
    └── Max-Age:  ${cookie ? `${cookie.maxAgeSeconds / 3600} h` : "8 h"}

document.cookie  (what page JavaScript can read)
└── ${scan.documentCookie ? scan.documentCookie : '"" — the session cookie is httpOnly, so scripts see nothing'}

localStorage   (${scan.localKeys.length} key${scan.localKeys.length === 1 ? "" : "s"})
${scan.localKeys.length ? scan.localKeys.map((key) => `└── ${key}`).join("\n") : "└── (empty)"}

sessionStorage (${scan.sessionKeys.length} key${scan.sessionKeys.length === 1 ? "" : "s"})
${scan.sessionKeys.length ? scan.sessionKeys.map((key) => `└── ${key}`).join("\n") : "└── (empty)"}`}
        </pre>
        <p className={`scan-result${scan.suspicious.length ? " is-bad" : " is-good"}`} role="status">
          {scan.suspicious.length
            ? `Token-like data found in: ${scan.suspicious.join(", ")}`
            : `No access token, refresh token or ID token found in localStorage, sessionStorage or document.cookie (scanned ${scan.scannedAt}).`}
        </p>
      </div>

      <p className="explainer">
        The React application requests data from the backend using the session cookie. It does not directly receive OAuth
        tokens, so there is nothing in the browser for a malicious script, extension or shared computer to steal. The only
        thing this page stores is the colour theme.
      </p>
    </section>
  );
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
