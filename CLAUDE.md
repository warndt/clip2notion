# Never start a Claude Code project from scratch

# [Project Name] — Claude Code Instructions

## Read First

Before making **any** change to this codebase:

1. Read `ROADMAP.md` in full. Confirm your change does not conflict with or make harder any planned work. If it does, flag the conflict and ask before proceeding.
2. Check the design system page at `/[ds-location]/` (if one exists) for established patterns, components, and design tokens.

---

## What This App Is

<!-- One-paragraph description of the project purpose, who uses it, and how it's deployed. Fill this in when bootstrapping the project. -->

---

## File Structure

<!-- Document the file structure here once established. Keep this up to date as files are added or moved. -->

```
/
├── CLAUDE.md               # This file — Claude Code instructions
├── ROADMAP.md              # Feature roadmap and task backlog (source of truth)
├── README.md               # Project overview, setup, and usage
└── ...
```

---

## Key Rules

### Scope & Approach

1. **Stay in scope.** Only make changes related to the current task. If you notice something else that needs fixing, note it in the Backlog section of ROADMAP.md — don't fix it.
2. **Understand before building.** Before building anything from scratch, understand the purpose of the application and the context of what already exists. Ask clarifying questions if the intent isn't clear.
3. **Build modularly.** Design components, modules, and data structures to be reusable and self-contained. Prefer small, focused files over monoliths.
4. **No surprise refactors.** Never delete or refactor working code without asking first. If you think something should be restructured, explain why and wait for approval.

### Development Philosophy

5. **Build in small, testable steps.** Each change should leave the app in a working state. Break large features into increments that can be tested and verified independently before moving on.
6. **Prototype risky features in isolation.** When a feature involves unfamiliar APIs, complex integrations, or uncertain approaches, build a minimal standalone proof of concept first. Validate that it works, understand the failure modes, then fold it into the main app. Flag when you think something warrants a prototype.
7. **Think about what comes next.** Before implementing, consider how this task fits into the broader roadmap. Choose data structures, field names, and patterns that won't need to be reworked when later features arrive. If a planned feature defines a field name or pattern, use it.

### Code & File Conventions

8. **Keep files small.** If a file is getting large, split it into focused modules. Use clear, descriptive filenames.
9. **No inline CSS or JS in HTML files** (unless the project explicitly calls for it). Styles and logic go in their own files. Exception: JSON-LD `<script type="application/ld+json">` blocks and analytics snippets (e.g. GA4) belong in the HTML.
10. **Mobile-first by default.** All UI work should be responsive and consider mobile as the primary target. Test or reason through mobile behaviour for any UI change.

### Design System

11. **Check the design system first.** Before creating new UI components or styles, check the design system page for existing patterns. If no design system page exists yet, flag this and ask about setting one up.
12. **Keep the design system in sync.** Whenever you change CSS, layout, component structure, colours, typography, or spacing, check whether the design system page needs updating. If it does, update it in the same commit.

### Roadmap & Task Tracking

13. **ROADMAP.md is the source of truth** for planned work. Read it before every task.
14. **Update ROADMAP.md as you work.** When you begin a task, mark it 🟡 (in progress). Do **not** mark tasks ~~complete~~ until the user has reviewed and approved the work.
15. **Add discovered work to the Backlog.** If you find bugs, tech debt, or ideas during development, add them to the Backlog section of ROADMAP.md rather than acting on them immediately.

### Git & Deployment

16. **Commit after every completed task.** Write clear, descriptive commit messages. One logical change per commit.
17. **Never commit secrets, API keys, or environment-specific config.** Use `.env` files, config templates, and `.gitignore`.

---

## Data Formats

<!-- Document any data schemas (JSON structures, database models, etc.) here so Claude can reference them when editing data files. -->

---

## Deployment

<!-- Document how the app is deployed: platform, build steps, environment variables, and any post-deploy steps. -->

---

## Design System

<!-- Record the design system page location here once established. Example: -->
<!-- Design system: `/ds/index.html` -->

⚠️ **No design system page has been set up yet.** When UI work begins, ask about creating one.

---
Version v1.2
https://wilarndt.com/resources/claude-bootstrap-prompt/
© 2026 Wil Arndt
