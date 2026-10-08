# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

(The UI is a React web app shown in an Electron macOS window with a hidden-inset title bar, and it also opens in a plain browser. The design language is the web's, not native AppKit.)

## Users
One developer: Ry, a software engineer on an aged-care company's AI team, reviewing their own changes before teammates see them. It's a personal tool with no team accounts and no other audiences.

Main situation: right after a `git push`, Ry glances at PuRR to see whether the background review passed, blocked or failed and whether anything is still running. Next most common: opening a finished run to read its findings carefully, like code-review comments, then tracking or dismissing them. Least often: editing flows in the node editor, assigning flows to triggers, managing repos and settings.

**When trade-offs collide, glanceable status wins** (confirmed by the user).

## Product Purpose
PuRR reviews the developer's own changes on git triggers, locally, by running user-editable **flows**:
- a pre-commit check that can block a secret;
- a pre-push check that can block a risky push;
- a post-push in-depth review.

Success means:
- a blocked commit or push is obvious and trustworthy;
- a finished review's must-fix findings are found within seconds;
- noise (dismissed, tracked or repeated findings) stays quiet.

## Positioning
- It drives the unmodified `claude` CLI headlessly under the user's own account. It never calls the Anthropic API and never reads credentials.
- One "context" seed session gathers facts about the PR, then gets forked into specialist reviewer **lenses**. The forks read the seed from the prompt cache.
- A skeptic **verify** step tries to refute each must-fix finding.
- Only a **gate** block can ever fail git.
- A fingerprinted **ledger** keeps repeated findings quiet.
- Reviews run in detached worktrees, so the user's checkout is never touched.

## Operating Context
- A macOS menu-bar app (Electron, in desktop/) runs a background service on 127.0.0.1:7878. The UI is in web/ (React 19, @xyflow/react 12, Vite).
- Data reaches the UI over a REST + SSE API (docs/API.md). Live run status streams in.
- Triggers:
  - git hooks for pre-commit and pre-push;
  - post-push, detected from push intent plus a `gh` poller;
  - manual "Run now".
- The app shares the window with macOS traffic lights at the top left. It runs alongside a terminal and an editor.

## Capabilities and Constraints
- **Pages:**
  - Runs: a live list with filters.
  - Run detail: the flow graph coloured by live block status, a block side panel, and review-comment findings with Track/Dismiss.
  - Flows: defaults are read-only; duplicate, delete, new.
  - Flow editor: a palette of 9 block types, drag-connect, inspector, template-variable helper, validation, auto-layout, unsaved indicator, ⌘S, and read-only mode.
  - Triggers matrix, Repos with hook toggles, Findings ledger, Settings (incl. a desktop-only App card).
  - Usage meters (5h / 7d / sessions today) and banners (paused, unreachable, rate-limited).
- **Block types:**
  - sources: scanner, command
  - sessions: context, branch, prompt, verify
  - results: merge, gate, output
- **Statuses and severities:**
  - Severities: must_fix, consider, minor, drop.
  - Ledger states: new, open, regression, dismissed, tracked.
  - Run statuses include passed, blocked, failed, running and queued.
- **Terms:** flow, block, lens, seed/context session, fork, gate, ledger, trigger.
- **Constraints:**
  - Every Claude run costs the user's quota.
  - No browser `alert` or `confirm`; confirms happen in the page.
  - Dark and light themes, plus reduced motion.

## Brand Commitments
- The name is "purr". Nothing visual is binding (confirmed): the icon, glyph and colours may all change, and so may how the name is set.
- **Standing preference (2026-10-08):** a Linear-style, monochrome tool shell. Neutral greys, ink primary actions, curved edges in the flow graph, no coloured accent. The user tried a transit-map "signage rail" direction and rejected it.
- **Anti-reference (user's verdict on the first design pass):** a purple→teal gradient accent "is very common for AI code". Anything that reads as a generic AI SaaS or AI dashboard is wrong.

## Evidence on Hand
- Real data comes from the local service: runs on a demo repo, three default flows, and the user flow "Quick review (haiku)".
- Screenshots of the previous design are in docs/screenshots/*.jpg.
- There are no customers, testimonials or metrics, and none should be invented.

## Product Principles
1. **Status first.** Pass, block, fail and running must be readable at a glance from any page.
2. **Findings read like a careful reviewer's comments:** what breaks, the fix, whether it was verified.
3. **Never alarming by accident.** Only real blocks and must-fixes get loud; everything else stays calm.
4. **A personal instrument, not a SaaS product.** It is one person's tool and should feel made for them.
5. **Respect the quota.** Actions that start Claude sessions are deliberate and clearly labelled.
