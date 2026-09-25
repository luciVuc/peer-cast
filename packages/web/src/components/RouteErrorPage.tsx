import { Link, isRouteErrorResponse, useRouteError } from "react-router-dom";
import { IllustratedMessage } from "./IllustratedMessage";

/**
 * Route-level error boundary (wired up via each route's `errorElement`).
 *
 * Without this, an exception thrown during render — e.g. calling a data-router
 * hook such as `useBlocker` outside a data router — unmounts the whole React
 * tree and leaves a blank page. This keeps the failure contained to one route
 * and offers the user a way back.
 */
export function RouteErrorPage() {
  const error = useRouteError();

  // Thrown by loaders/actions: has a real HTTP status.
  if (isRouteErrorResponse(error)) {
    return (
      <IllustratedMessage
        icon="🧭"
        title={`${error.status} ${error.statusText || "Error"}`}
        description={typeof error.data === "string" ? error.data : undefined}
        action={<BackToHome />}
      />
    );
  }

  // An unexpected render/loader exception. This app is self-hosted for known
  // operators, so the message is more useful than hidden.
  const detail = error instanceof Error ? error.message : undefined;

  return (
    <IllustratedMessage
      icon="⚠️"
      title="Something went wrong"
      description={
        detail ?? "This page failed to load. Try again, or head back home."
      }
      action={<BackToHome />}
    />
  );
}

function BackToHome() {
  return (
    <Link
      to="/"
      className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
    >
      Back to home
    </Link>
  );
}
