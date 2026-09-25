import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders user-supplied markdown (currently the profile "about" blurb).
 *
 * SAFETY: `about` is attacker-controlled and is shown on the dashboard and on
 * every public profile page, so this must never become an HTML injection
 * vector. `react-markdown` renders to React elements rather than injecting
 * HTML — it deliberately drops raw HTML in the source (no `rehype-raw` /
 * `allowDangerousHtml` here) and passes URLs through `defaultUrlTransform`,
 * which strips `javascript:` / `data:` schemes. Do not add either escape hatch
 * without a sanitiser.
 *
 * `remark-gfm` adds tables, strikethrough, task lists and autolinked URLs.
 */
export function Markdown({ children }: { children: string }) {
  // Whitespace-only content would otherwise render an empty, clickable-looking
  // block. Callers also guard on truthiness — a string of spaces passes that.
  if (!children.trim()) return null;

  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Off-site links open in a new tab; `noreferrer` keeps the profile
          // author's session-bearing Referer away from third parties.
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer nofollow" />
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
