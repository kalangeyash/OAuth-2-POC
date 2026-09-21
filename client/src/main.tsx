import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { AUTH_POPUP_NAME } from "./api";
import { App } from "./App";
import "./styles.css";

/*
 * Popup mode: /callback (and any error during the flow) redirects to this app's
 * URL. Inside the authorization popup that would load a second copy of the lab,
 * so the popup shows a short note and closes itself. The lab in the main window
 * has already shown every step live.
 */
function PopupDone() {
  useEffect(() => {
    const timer = window.setTimeout(() => window.close(), 1200);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <main className="popup-done">
      <h1>Authorization finished</h1>
      <p>This window closes by itself. The Protocol Lab in the main window shows exactly what happened.</p>
      <button type="button" className="button" onClick={() => window.close()}>
        Close now
      </button>
    </main>
  );
}

const inAuthPopup = window.name === AUTH_POPUP_NAME && window.opener !== null && !window.opener.closed;

createRoot(document.getElementById("root")!).render(<StrictMode>{inAuthPopup ? <PopupDone /> : <App />}</StrictMode>);
