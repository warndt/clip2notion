# Contributing

Short version: **suggestions yes, pull requests no, forks encouraged.**

## Pull requests are not accepted

Not because contributions aren't valued — because of what this repository is. It is a personal tool that runs one person's workflow, published in case the approach is useful to someone else. It has one user, one deployment, and a set of constraints in [CLAUDE.md](CLAUDE.md) that mostly exist because something failed silently in production and cost an afternoon to find.

Merging changes I can't exercise against that workflow would mean either sitting on them or shipping them untested. Both are worse than saying no clearly up front.

If you send a PR anyway, it will be closed with a pointer to this file. That isn't a judgement on the code.

## What is welcome

**Open an issue.** Genuinely useful, and the most likely thing to change the code:

- **A site that clips badly.** The most valuable report there is. Include the URL and what went wrong — a missing section, a mangled table, an image that came through as a 1×1 spacer. Nearly every fix in `ROADMAP.md`'s backlog started as one real article that broke something, and every one of them became a test case.
- **A bug with a reproduction.** What you called, what happened, what you expected.
- **A security finding.** Not as a public issue — see [SECURITY.md](SECURITY.md).
- **A question about adapting it.** If the README didn't cover it, that's a README bug and worth reporting as one.

**Fork it.** This is the encouraged path, and the licence is MIT precisely so you don't have to ask. If your setup differs from mine — a different platform, a different database, no Claude at all — a fork will serve you better than a configuration flag I'd have to maintain and can't test. The [Adapting it](README.md#adapting-it) section is written for exactly that.

If you build something interesting on top of it, I'd like to hear about it. That's an issue too.

## If you're reading the code

Two things that will save you time:

1. **Read [CLAUDE.md](CLAUDE.md) first.** It documents the constraints that fail *late and silently* rather than in testing — the 10-second synchronous ceiling, why jsdom must stay out of the light half of `src/`, Notion's 2,000-character rich-text cap, and why a background function must almost never throw. Several of those look like arbitrary awkwardness until you know what they're avoiding.
2. **`ROADMAP.md`'s backlog is a failure log, not a wishlist.** Each entry records what broke, what the root cause turned out to be, and — often — which plausible-sounding fix was wrong and why. If you're about to change something and there's an entry about it, read that first.

The tests cover the failure modes that are invisible from the service's side: content that duplicates on retry, text truncated at a limit, an image that degrades to a hotlink, a status endpoint that reports a clip which never happened. Those are the ones worth keeping green.
