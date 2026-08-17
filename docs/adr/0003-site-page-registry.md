# One site page registry for canonical links, sitemaps, and prerendering

Status: superseded by [ADR 0004](./0004-remove-marketing-landing-system.md)

The Production Site must keep its canonical origin, its localized alternates, its sitemap, its
prerendered documents, and its own internal links in agreement. Today two places decide this
independently: the Router holds a landing-page table and derives canonical, hreflang, robots, and
sitemap from the Public Base URL, while the prerender build step hard-codes which localized
documents it writes. A page added in one place and not the other produces a sitemap entry with no
document, or a document that no crawler is told about.

We will put the brand name and the page registry in a new zero-dependency package,
`packages/site-config`, and let the Router, the prerender build step, and the Workshop frontend all
read that one table. Each row states a locale-free path, which locales it exists in, whether it is
indexable, and whether it is prerendered. Adding a public page becomes one data row. The frontend
also renders navigation and footer links from the registry, so a link cannot point at a page that
has not shipped.

This gives the Router its first workspace dependency, which is a real cost in a package that was
deliberately dependency-free. We accept it because the alternative is a second source of truth for
the same facts, and because the new package exports constants and pure functions only — no runtime
dependency, no I/O, and nothing that can change Router behaviour by itself.

We rejected two alternatives:

- Keeping the table in the Router and letting the prerender step keep its own list, because the two
  lists drift silently and the failure is invisible until a crawler reports it.
- Moving the table into `packages/workshop-shared`, because that package is the RPC contract
  between the client and the kernel; static site metadata does not belong in it, and the Router
  would then depend on the whole API surface.
