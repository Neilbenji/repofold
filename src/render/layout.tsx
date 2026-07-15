// Static page shell replicating the cloud wiki chrome: share topbar, sidebar
// with the navigation tree, article body, table of contents, pager. The
// interactive behaviors (nav collapse, toc scroll-spy, copy buttons) are
// restored by assets/js/repofold.js.
import type { ReactNode } from "react";
import type { WikiNode } from "./wiki-tree.js";
import type { TocItem } from "./extract-headings.js";

export type PagerLink = { title: string; href: string } | null;

function BrandMark() {
  return (
    <svg className="brand-logo-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="38" height="38" rx="12" fill="currentColor" />
      <path
        d="M9.5 13v16.25A2.75 2.75 0 0 0 12.25 32H26"
        stroke="var(--brand-logo-surface, #fff)"
        strokeWidth="2"
        strokeLinecap="round"
        opacity=".52"
      />
      <path
        d="M12 8.5h11.25L30 15.25v15.5A1.25 1.25 0 0 1 28.75 32h-15.5A1.25 1.25 0 0 1 12 30.75V8.5Z"
        fill="var(--brand-logo-surface, #fff)"
      />
      <path d="M23.25 8.5 30 15.25h-6.75V8.5Z" fill="var(--brand-logo-accent, #8BE0C1)" />
      <path d="M17 19h8M17 23h8M17 27h5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

function NavPage({ node, active, root, href }: { node: WikiNode; active: boolean; root?: boolean; href: string }) {
  const className = ["wiki-nav-link", root ? "wiki-nav-link-root" : "", active ? "active" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <a href={href} className={className} aria-current={active ? "page" : undefined} title={node.title}>
      {node.title}
    </a>
  );
}

function NavigationTree({
  tree,
  activeSlug,
  hrefFor,
}: {
  tree: WikiNode[];
  activeSlug: string;
  hrefFor: (slug: string) => string;
}) {
  return (
    <>
      {tree.map((node) =>
        node.kind === "section" ? (
          <div className="wiki-nav-section" key={node.slug}>
            <button className="wiki-nav-group" type="button" aria-expanded>
              <span>{node.title}</span>
              <svg className="wiki-nav-caret open" viewBox="0 0 16 16" aria-hidden="true">
                <path d="m6 4 4 4-4 4" />
              </svg>
            </button>
            <div className="wiki-nav-children-wrap">
              <div className="wiki-nav-children">
                {node.children.map((child) => (
                  <NavPage
                    key={child.slug}
                    node={child}
                    active={child.slug === activeSlug}
                    href={hrefFor(child.slug)}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : (
          <NavPage key={node.slug} node={node} active={node.slug === activeSlug} root href={hrefFor(node.slug)} />
        ),
      )}
    </>
  );
}

export function WikiPage({
  repo,
  githubUrl,
  tree,
  activeSlug,
  hrefFor,
  assetHref,
  changelogHref,
  toc,
  prev,
  next,
  commitSha,
  includeMermaid,
  children,
}: {
  repo: { owner: string; name: string };
  githubUrl: string | null;
  tree: WikiNode[];
  activeSlug: string;
  hrefFor: (slug: string) => string;
  assetHref: (file: string) => string;
  changelogHref: string | null;
  toc: TocItem[];
  prev: PagerLink;
  next: PagerLink;
  commitSha: string;
  includeMermaid: boolean;
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="generator" content="repofold" />
        <title>{`${repo.owner}/${repo.name} wiki`}</title>
        <link rel="icon" href={assetHref("favicon.svg")} type="image/svg+xml" />
        <link rel="stylesheet" href={assetHref("css/tokens.css")} />
        <link rel="stylesheet" href={assetHref("css/base.css")} />
        <link rel="stylesheet" href={assetHref("css/wiki.css")} />
        <link rel="stylesheet" href={assetHref("css/markdown.css")} />
        {includeMermaid && <script defer src={assetHref("js/mermaid.min.js")} />}
        <script defer src={assetHref("js/repofold.js")} />
      </head>
      <body>
        <div className="wiki-shell share-shell">
          <aside className="wiki-sidebar">
            <div className="wiki-sidebar-head">
              <span className="wiki-sidebar-repo">
                <span className="wiki-repo-mark" aria-hidden="true">
                  <svg viewBox="0 0 20 20">
                    <path d="M4.5 3.25h8.75a2 2 0 0 1 2 2v11.5H6.5a2 2 0 0 1-2-2V3.25Z" />
                    <path d="M7.5 6.5h4.75M7.5 9.5h3.25M6.5 16.75a2 2 0 0 1 0-4h8.75" />
                  </svg>
                </span>
                <span className="wiki-repo-copy">
                  <strong>{repo.name}</strong>
                  <small>{repo.owner} · Documentation</small>
                </span>
              </span>
            </div>
            <div className="wiki-sidebar-label">Contents</div>
            <nav className="wiki-sidebar-nav" aria-label={`${repo.name} wiki pages`}>
              <NavigationTree tree={tree} activeSlug={activeSlug} hrefFor={hrefFor} />
            </nav>
            {changelogHref && (
              <nav className="wiki-sidebar-foot" aria-label="Repository tools">
                <a href={changelogHref}>
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M10 4a6 6 0 1 1-5.2 3" />
                    <path d="M2.7 3.8v4h4M10 6.5V10l2.3 1.4" />
                  </svg>
                  Changelog
                </a>
              </nav>
            )}
          </aside>
          <div className="wiki-main">
            <header className="share-topbar">
              <span className="share-repo">
                <span className="share-owner">{repo.owner}/</span>
                {repo.name}
              </span>
              <span className="share-badge">Generated by RepoFold</span>
              <span className="share-spacer" />
              {githubUrl && (
                <a href={githubUrl} target="_blank" rel="noreferrer" className="share-gh">
                  GitHub ↗
                </a>
              )}
              <a href="https://repofold.dev" target="_blank" rel="noreferrer" className="share-gh">
                <BrandMark />
              </a>
            </header>
            <div className="wiki-body">
              <article className="wiki-article prose">
                {children}
                <footer className="page-footer">
                  <span>
                    Generated from commit <code>{commitSha.slice(0, 7)}</code>
                  </span>
                </footer>
                {(prev || next) && (
                  <nav className="page-pager">
                    {prev && (
                      <a className="pager-card prev" href={prev.href}>
                        <span className="pager-dir">← Previous</span>
                        <span className="pager-title">{prev.title}</span>
                      </a>
                    )}
                    {next && (
                      <a className="pager-card next" href={next.href}>
                        <span className="pager-dir">Next →</span>
                        <span className="pager-title">{next.title}</span>
                      </a>
                    )}
                  </nav>
                )}
              </article>
              {toc.length >= 2 && (
                <nav className="wiki-toc">
                  <div className="wiki-toc-label">On this page</div>
                  <ul>
                    {toc.map((item) => (
                      <li key={item.id} className={item.depth === 3 ? "depth-3" : undefined}>
                        <a href={`#${item.id}`} title={item.text}>
                          {item.text}
                        </a>
                      </li>
                    ))}
                  </ul>
                  <div className="wiki-toc-progress">
                    <div className="bar">
                      <div style={{ width: "0%" }} />
                    </div>
                    <span>0%</span>
                  </div>
                </nav>
              )}
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
