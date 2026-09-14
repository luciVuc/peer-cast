import type { ReactNode } from "react";

/**
 * A centered, illustrated empty/error state — used when a broadcast is
 * offline, a page is empty, or something went wrong.
 */
export function IllustratedMessage({
  icon = "📡",
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 text-5xl" aria-hidden>
        {icon}
      </div>
      <h2 className="text-xl font-semibold text-slate-100">{title}</h2>
      {description && (
        <p className="mt-2 max-w-md text-sm text-slate-400">{description}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
