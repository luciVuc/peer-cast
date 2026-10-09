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
          /*
           * Remote images are stripped here rather than left to the server's
           * CSP (`img-src 'self' data: blob:`), which already blocks them.
           *
           * Two layers are worth having: an `![](https://tracker/beacon.png)`
           * in a profile blurb would otherwise fire a request from every
           * visitor's browser, turning this into a read-receipt beacon for
           * anyone who opens a profile — and it would keep working the moment
           * anyone relaxes that CSP header. Blocking at the component means the
           * safety travels with the data, not with the server config.
           *
           * Profile blurbs have no use for embedded images; links still work.
           */
          img: ({ node, ...props }) => {
            const src = typeof props.src === "string" ? props.src : "";
            const sameOrigin = src.startsWith("/") || src.startsWith("./");
            if (!sameOrigin) return null;
            return (
              <img {...props} loading="lazy" referrerPolicy="no-referrer" />
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
