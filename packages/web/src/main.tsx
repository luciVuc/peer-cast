import React from "react";
import ReactDOM from "react-dom/client";
import { Provider } from "react-redux";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { store } from "./store";
import { tokensUpdated, loggedOut } from "./store/authSlice";
import "./index.css";

/**
 * If the user has a cached profile in localStorage, attempt a silent token
 * refresh via the HttpOnly refresh-token cookie before mounting React.
 * This restores the session without a /login redirect on page reload.
 * The refresh call completes in < 100ms on localhost; on a remote server the
 * delay is imperceptible compared to the rest of the page load.
 */
async function boot() {
  const { auth } = store.getState();
  if (auth.user && !auth.hydrated) {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        // Ensure the HttpOnly cookie is included (same-origin fetch always
        // sends cookies, but being explicit is harmless).
        credentials: "same-origin",
      });
      if (res.ok) {
        const data = (await res.json()) as { accessToken: string };
        store.dispatch(tokensUpdated({ accessToken: data.accessToken }));
      } else {
        // Cookie expired or revoked — clear the stale user cache.
        store.dispatch(loggedOut());
      }
    } catch {
      store.dispatch(loggedOut());
    }
  }

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Provider store={store}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </Provider>
    </React.StrictMode>,
  );
}

void boot();
