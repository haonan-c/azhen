# Remove the Marketing Landing Page system

Status: accepted

The Marketing Landing Page work added a separate public-site experience, static prerendering, SEO
rules, a site page registry, and an anonymous tool path around the Workshop. The resulting page and
deployment structure does not match the current product direction. The public page composition and
SEO strategy need a new design before more work continues.

We will remove the Marketing Landing Page system, including the Hub and About pages, the Anonymous
Angle Run, the site page registry, prerendering, Router SEO handling, and the public frontend release
variant. A deployment will return to the Workshop application as its primary surface. The Workshop's
English and Chinese UI, Blueprint surfaces, and unrelated fixes remain in place.

ADR 0002 and ADR 0003 remain in the repository as decision history, but this decision supersedes
them. A future public-site or SEO architecture requires a new decision record; it must not assume
that either removed design is still active.

This removes the current indexable marketing documents and their crawler metadata. It also removes
the anonymous landing tool and the Hub/About routes. The Router and release pipeline no longer need
to coordinate a separate public frontend asset variant. Future page composition, canonical URLs,
and SEO behavior remain intentionally undecided.
