---
version: 1
slug: "web-src-app-tsx"
primary_target: "web/src/App.tsx"
related_targets: []
---

# purr web UI (all pages)

Scope: the whole operator UI in web/ (Runs, Run detail, Flows, Flow editor, Triggers, Repos, Findings, Settings) plus the app icon. Mode: Operate.
Audience/job: one developer glancing after a push (status first), then reading findings, occasionally editing flows. Constraints: see PRODUCT.md; hidden-inset macOS title bar, dark + light, reduced motion.

## Direction contract

THESIS: A Linear-calibre monochrome tool shell. The only colour is meaning: state (pass/block/fail/running, severities) and the nine block types. Refuses the purple→teal gradient AI-dashboard accent. This was the user's own choice (the standing exit, the category standard played straight), taken after they rejected the transit-map signage rail.

OWN-WORLD: neutral grey ground with a one-step-darker sidebar, white/graphite surfaces, hairline borders, 6–9px radii. Primary actions are solid ink; focus and selection are neutral. Overpass for UI, Overpass Mono for code. Block types are solid round bullets in fixed line colours, used in the palette, nodes, legend, minimap, finding sources and mini route diagrams. Status is shown by shape-coded station markers: a filled check, a barred disc, a crossed disc, a pulsing ring, a hollow ring.

STORY: open purr after a push and see the run's status marker; open the run to watch blocks complete on the graph; read must-fix findings first; track or dismiss them; edit a flow when needed.

FIRST VIEWPORT: Runs. Sidebar on the left with the ink-tile mark, "purr" and icon nav, with the toolchain and live state at its foot. Header with the page name, plus the 5h/7d meters and sessions on the right. Main area: the title with an ink "Run now" button, filter tabs (the active tab solid ink), then the runs table led by status markers.

SIGNATURE: every flow is drawn as a mini route diagram, coloured by block type, on the Flows cards and in the editor inspector. On run graphs and in the editor, edges are curves in the source block's colour. Finished track is solid, track still ahead fades, and the live edge animates. Motion conveys state only.

FORM: category standard (Linear-style), chosen by the user over the rolled and picked directions. Seed key 3c7e38f9.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
