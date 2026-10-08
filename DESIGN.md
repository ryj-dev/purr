---
name: purr
description: A personal, local PR reviewer. A quiet monochrome tool shell where colour only ever means something.
colors:
  ink: "#12161b"
  ink-hover: "#2b313a"
  ink-fg: "#ffffff"
  ground: "#fafafb"
  sidebar: "#f1f1f3"
  sunken: "#f3f3f5"
  surface: "#ffffff"
  surface-2: "#f5f5f7"
  surface-3: "#ebebee"
  text: "#12161b"
  text-2: "#464d57"
  text-3: "#69717c"
  text-4: "#a2a8b0"
  border: "rgba(16, 22, 30, .1)"
  border-2: "rgba(16, 22, 30, .16)"
  border-3: "rgba(16, 22, 30, .3)"
  hover: "rgba(16, 22, 30, .045)"
  active: "rgba(16, 22, 30, .08)"
  focus: "rgba(18, 22, 27, .5)"
  ok: "#0b7a43"
  warn: "#b26800"
  danger: "#cc2a1f"
  info: "#1f5fd6"
  on-status: "#ffffff"
  sev-minor: "#69717c"
  block-scanner: "#e2601a"
  block-command: "#8a5a2e"
  block-context: "#1b3f99"
  block-branch: "#0a91c9"
  block-prompt: "#b0136b"
  block-merge: "#6c9b12"
  block-verify: "#008f84"
  block-gate: "#e2ae00"
  block-output: "#848c95"
  dark-ground: "#131417"
  dark-sidebar: "#0d0e10"
  dark-surface: "#18191d"
  dark-ink: "#eceef1"
typography:
  display:
    fontFamily: "'Overpass Variable', Overpass, -apple-system, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 750
    lineHeight: 1.25
    letterSpacing: "-.012em"
  headline:
    fontFamily: "'Overpass Variable', Overpass, -apple-system, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 750
    lineHeight: 1.3
  title:
    fontFamily: "'Overpass Variable', Overpass, -apple-system, system-ui, sans-serif"
    fontSize: "14.5px"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "-.005em"
  body:
    fontFamily: "'Overpass Variable', Overpass, -apple-system, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.5
    fontFeature: "tnum"
  label:
    fontFamily: "'Overpass Variable', Overpass, -apple-system, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 650
    lineHeight: 1.4
  mono:
    fontFamily: "'Overpass Mono', ui-monospace, 'SF Mono', Menlo, monospace"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.65
rounded:
  sm: "5px"
  md: "6px"
  logo: "7px"
  lg: "9px"
  full: "50%"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  page: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ink-fg}"
    rounded: "{rounded.md}"
    height: "30px"
    padding: "1px 12px 0"
  button-primary-hover:
    backgroundColor: "{colors.ink-hover}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "30px"
    padding: "1px 12px 0"
  button-secondary-hover:
    backgroundColor: "{colors.surface-2}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.md}"
    height: "30px"
  button-ghost-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.text}"
  button-sm:
    rounded: "{rounded.sm}"
    height: "26px"
    padding: "1px 9px 0"
  input-text:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    height: "32px"
    padding: "1px 10px 0"
  nav-item:
    textColor: "{colors.text-2}"
    rounded: "{rounded.md}"
    height: "30px"
    padding: "1px 10px 0"
  nav-item-active:
    backgroundColor: "{colors.active}"
    textColor: "{colors.text}"
  tab-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ink-fg}"
    rounded: "{rounded.sm}"
    height: "26px"
  chip:
    textColor: "{colors.text-2}"
    rounded: "{rounded.sm}"
    height: "22px"
    padding: "1px 8px 0"
  sev-must-fix:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.on-status}"
    rounded: "{rounded.sm}"
    height: "22px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "18px 20px"
  block-node:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    width: "232px"
  type-tile:
    rounded: "{rounded.full}"
    size: "26px"
  logo-tile:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.ink-fg}"
    rounded: "{rounded.logo}"
---

# Design System: purr

## Overview

**Creative North Star: "The Quiet Instrument"**

PuRR is one developer's review instrument, set in the category-standard idiom of a Linear-calibre tool shell and played straight. The shell is monochrome: a neutral grey ground, a sidebar one step darker, white (or graphite) surfaces, hairline borders and solid-ink primary actions. Nothing in the chrome is coloured. When colour appears, it carries meaning, either a state (passed, blocked, failed, running, plus the must-fix / consider / minor severities) or one of the nine flow block types.

Density is compact and desktop-first: 13.5px body, 30px controls and tight 6–9px corners, so a run's status reads at a glance beside a terminal and an editor. The signature is the flow drawn as a route. Block types are solid round bullets in fixed line colours, graph edges are curves in the source block's colour, and every flow card carries a small route diagram. Motion only ever reports state, like a running pulse or an animated live edge.

This world was the user's own choice, made after they rejected two directions. One was the first pass's purple→teal gradient accent ("very common for AI code"). The other was a transit-map "signage rail". Anything that reads as a generic AI SaaS dashboard is wrong.

**Key Characteristics:**
- Monochrome neutral shell. Ink primary buttons, neutral focus rings and neutral selection.
- Colour is reserved for state and for the nine block types.
- Status is coded by shape first (station markers) and by colour second.
- Flat hairline-bordered surfaces. Shadows appear only on floating layers and graph nodes.
- Light tokens at `:root`, with a full dark set under `prefers-color-scheme: dark`.
- Overpass for UI, Overpass Mono for code, with tabular numerals throughout.

## Colors

The palette is a grey-scale shell plus two closed, meaningful palettes: four state colours and nine block-type line colours.

### Primary
- **Graphite Ink** (`ink`): fills primary buttons, the active filter tab, checked switches and checkboxes, the logo tile, selected nodes and selected edges. In dark mode it inverts to near-white (`dark-ink`), and its foreground (`ink-fg`) flips to near-black. Hover lifts it one step (`ink-hover`).

### Neutral
- **Paper Ground** (`ground`): the content background, the canvas, and route strips inside cards.
- **Sidebar Grey** (`sidebar`): the sidebar, one step darker than the ground. In dark mode it is darker still (`dark-sidebar`).
- **Sunken Grey** (`sunken`): the minimap mask and recessed areas.
- **Surface White / Surface 2 / Surface 3** (`surface`, `surface-2`, `surface-3`): cards, tables, panels and the palette and inspector. Surface 2 is used for file-group heads, fix boxes, modal footers and button hover. Surface 3 is used for pressed states, meter tracks and the switch track.
- **Text ramp** (`text`, `text-2`, `text-3`, `text-4`): primary text, secondary text (and icons inside buttons), tertiary meta and hints, and disabled or hollow markers.
- **Hairlines** (`border`, `border-2`, `border-3`): translucent ink at 10 / 16 / 30%. The rest border goes on panels, the stronger one on controls, and the strongest marks hover and focus.
- **Hover / Active washes** (`hover`, `active`): translucent ink for row, nav and ghost-button hover, and for the active nav item.

### State (semantic, not accent)
- **Pass Green** (`ok`): passed and done, connected tools, the "Live" connection dot.
- **Block Amber** (`warn`): blocked runs, the consider severity, warnings, the mid-usage meter.
- **Fail Red** (`danger`): failed runs, the must-fix severity (solid fill), errors, broken track, the high-usage meter, destructive buttons.
- **Running Blue** (`info`): running status, the live animated edge, info toasts.
- Severities map onto state: must_fix is `danger` (solid), consider is `warn` (a 15% tint), and minor is neutral grey (`sev-minor`, shown on `surface-2` with an inset hairline).

### Block-type line colours
Nine fixed hues, one per block type: scanner orange, command brown, context navy, branch cyan, prompt magenta, merge green, verify teal, gate yellow and output grey (`block-*`, CSS `--c-*`). The same values are used by the palette, node bullets, edges, the minimap, the legend, finding sources and mini route diagrams. Each has a brighter dark-mode counterpart. Gate and merge bullets take a dark glyph for contrast. The others take white.

### Named Rules
**The Colour-Is-Meaning Rule.** Every hue on screen is either a state or a block type. Chrome, focus, selection, links and primary actions stay neutral ink. A colour that means nothing is a defect.

**The No-Accent Rule.** There is no brand accent colour. Links are ink and are underlined inside running text. They are never tinted.

**The Tint, Not Fill Rule.** State backgrounds are `color-mix` tints of the state colour (7–15%) over the surface. The only solid state fills are the must-fix severity, the failed and passed station-marker discs, and the solid danger button.

## Typography

**Display Font:** Overpass Variable (with -apple-system, system-ui)
**Body Font:** Overpass Variable
**Label/Mono Font:** Overpass Mono (with ui-monospace, SF Mono, Menlo)

**Character:** Overpass is a highway-signage grotesque, so it reads as engineered without becoming decorative. Heavy weights (700–800) carry hierarchy at small sizes. The mono face sets code, SHAs, branches, file paths and block summaries.

### Hierarchy
- **Display** (750, 22px, 1.25, -.012em): page titles. The brand name sets at 800 / 16px.
- **Headline** (750, 18px): section heads such as "Findings" on run detail.
- **Title** (700–750, 14.5–15px): card and panel heads, finding titles (15px, 1.4) and flow-card names.
- **Body** (400, 13.5px, 1.5): running UI text. Prose blocks cap at 72–80ch (finding scenarios 80ch, page subtitles 72ch).
- **Label** (650, 12px): field labels, nav group labels (11.5px), chips and table headers (700). Labels are sentence case and never letter-spaced uppercase.
- **Mono** (400, 11.5px, line-height 1.65 in output blocks): code, SHAs, paths, tool names.

### Named Rules
**The Tabular Rule.** The body sets `font-variant-numeric: tabular-nums`, so counts, durations and meters never jitter as they update live.

**The Borrowed Dot Rule.** Overpass draws the middle dot off-centre. A `purr-dot` face maps U+00B7 to Helvetica/Arial so names like "Lens · Security" sit level. Keep it at the head of the sans stack.

## Layout

The app is a two-column grid: a 216px sidebar and fluid content. The sidebar holds a 50px brand row, grouped icon-plus-label nav, and a foot with the toolchain card and the connection state. Content has a 48px header (page name on the left; 5h/7d meters and sessions on the right) and a scrolling main area. Pages pad 28px 32px 56px and cap at 1320px (1680px for wide pages). The page header aligns its title block and actions to the bottom edge.

Spacing follows a 4px-based rhythm, dominated by 8, 12 and 16px gaps. Cards pad 18px 20px, card grids use `minmax(330px, 1fr)` with 16px gaps, and table cells pad 9px 14px. The flow editor is a three-column grid: palette 236px, canvas fluid, inspector 372px (204 / 330px below 1100px). Run detail pairs the graph with a 380px side panel and stacks them below 1100px.

**Narrow (≤760px):** the sidebar folds to a 56px icon rail. Labels, nav groups and the toolchain hide, and nav items grow to 36px tall. The header drops sessions. Grids collapse to one column, the editor hides its palette and inspector, and tables scroll horizontally.

**Desktop (`.desktop`):** in the Electron window with its hidden-inset title bar, the brand row pads 84px left to clear the traffic lights and hides the version. The brand row, header and editor bar are drag regions, and every control inside them opts out with `no-drag`. At narrow widths the brand row instead gains 28px of top clearance.

## Elevation & Depth

The base is flat and tonal. Depth comes from the ground/sidebar/surface steps and hairline borders. Shadows are reserved for things that float or can be picked up.

### Shadow Vocabulary
- **Resting node** (`--shadow-sm`: `0 1px 2px rgba(16,22,30,.06)`): graph block nodes only.
- **Lift** (`--shadow-md`: `0 4px 12px rgba(16,22,30,.08), 0 1px 3px rgba(16,22,30,.06)`): flow-card hover and selected nodes.
- **Float** (`--shadow-lg`: `0 18px 48px rgba(16,22,30,.18), 0 2px 8px rgba(16,22,30,.08)`): modals and toasts.
- **State rings** (`0 0 0 3px` of a 16–20% tint): selected (ink), running (info) and error (danger) nodes, plus a 10% ink ring on focused inputs.

The dark theme deepens every shadow to black at .3–.55.

### Named Rules
**The Flat-At-Rest Rule.** Cards, tables and panels never carry a shadow at rest. A shadow means the thing floats, is being hovered, or is selected.

## Shapes

Corners are gently rounded on a tight scale: 5px (`--r-sm`) for small buttons, chips, tabs and badges; 6px (`--r`) for buttons, inputs, nav items and inset panels; 9px (`--r-lg`) for cards, tables, nodes, modals and toasts. The logo tile uses 7px. Circles are semantic. Block-type bullets, station markers, status dots and card-head icons are always round. Borders are 1px hairlines, except block nodes, which use 1.5px. Dashed borders mean degraded or not taken: skipped or cancelled nodes, warning nodes, broken or live track, and the selection marquee.

## Components

### Buttons
Quiet and solid, with one ink action per view.
- **Shape:** gently rounded (6px), 30px tall; small buttons are 26px with 5px corners; icon buttons are square.
- **Primary:** an ink fill with an `ink-fg` label at weight 650 / 13px. Hover lifts to `ink-hover`. Keyboard hints inside sit at 72% ink-fg.
- **Secondary (default):** a surface fill with a `border-2` hairline. Hover goes to `surface-2` / `border-3`, and pressed goes to `surface-3`.
- **Ghost:** transparent with `text-2`. Hover takes the `hover` wash.
- **Danger:** red text on a surface; hover adds a 9% danger tint. The solid danger variant is a red fill, reserved for confirming a destructive action.
- **Focus:** a 2px `focus` outline at a 2px offset. It is neutral, never coloured. Disabled is 42% opacity.

### Filter Tabs (segmented)
A 2px-padded hairline group. The selected tab is a solid ink panel with an `ink-fg` label. Counts sit at 65% of the label colour.

### Chips, Status and Severity
- **Chip:** 22px tall, 5px corners, 12px / 650. Neutral chips use a `border-2` hairline. State chips drop the border and take a 12–14% tint of their state colour.
- **Status:** a station marker plus a capitalised 12.5px / 700 label in the state colour.
- **Severity badge:** must-fix is a solid danger fill, consider is a 15% warn tint, and minor is neutral with an inset hairline. Severity counts (`.counts`) reuse the same three treatments as 22px squares.

### Station Markers (signature)
Status is drawn as a 16-unit SVG marker whose shape carries the state, with colour repeating it: passed/done is a filled green disc with a check; blocked is an amber disc with a bar; failed is a red disc with a cross; running is a blue ring with a centre dot and an expanding pulse; queued/pending is a hollow grey ring; skipped/cancelled/superseded is a hollow ring with a slash. Markers lead every runs-table row and every node, and they appear in the map key.

### Block-Type Bullets
A solid round disc in the type's line colour, holding its Lucide icon at stroke 2.4. Sizes are 20, 26 (default) and 32px, and 34px in compact nodes. This is the only way a block type is shown.

### Block Nodes and the Flow Graph (signature)
- **Node:** 232px wide, on a surface with a 1.5px `border-2` and 9px corners. A top row holds the bullet, a 13px / 750 label, a mono summary and a status marker. A status footer sits under a hairline.
- **States:** selected nodes take an ink border plus an ink ring. Running nodes take an info border and ring. Failed nodes take a danger border and a 6% danger wash. Warnings get a dashed amber border. Pending nodes sit at 62% opacity, and skipped or cancelled ones at 50% with a dashed border.
- **Compact mode:** below zoom 0.62, nodes drop the summary and footer, enlarge the bullet to 34px, and set the label at 20px across up to two lines, so the graph stays legible zoomed out.
- **Edges:** 2px bezier curves stroked in the source block's colour, ending in a 12px closed arrowhead of the same colour (2.6px on hover or select; a selected edge turns ink). On a run, travelled track is solid, track ahead fades to 30%, a broken edge is dashed red, and the live edge is dashed blue and animates.
- **Handles:** 10px surface discs ringed in a 75% mix of the type colour. On hover they fill with the type colour and scale to 1.25.
- **Chrome:** the minimap and controls use hairline-bordered 6px panels with no shadow, and the canvas has no background pattern.

### Route Mini (signature)
Each flow appears as a small route diagram: one column per depth (34px apart), 4px dots in the block colour ringed in surface, and 3px lines in the source block's colour that run level, bend at 45° and run level again. It sits in a ground-coloured strip on every Flows card and at the top of the editor inspector.

### Cards / Containers
- **Corner Style:** gently rounded (9px).
- **Background:** surface on the ground, with a 1px `border` hairline.
- **Shadow Strategy:** flat at rest; flow cards lift on hover (see Elevation).
- **Internal Padding:** 18px 20px. Tables and file groups clip to their 9px corners, with surface-2 heads 36–38px tall.

### Inputs / Fields
- **Style:** a surface fill with a `border-2` hairline, 6px corners, 32px tall, 13px text. Textareas use mono at 12px with a 1.65 line height.
- **Focus:** the border goes to `border-3`, plus a 3px ring of 10% ink. There is no colour.
- **Disabled:** a surface-2 fill with `text-2`. Switches are 30×18 tracks that fill ink when on. Checkboxes use the ink accent colour.

### Navigation
Sidebar items are 30px tall with 6px corners, 13.5px / 600 `text-2` labels and `text-3` icons. Hover takes the `hover` wash. Active takes the `active` wash plus full-strength text and icon. Group labels are 11.5px / 650 `text-3`, in sentence case. The brand row shows the logo (the mark in `ink-fg` on a 7px ink tile), "purr" at 800, and the version in mono.

### Logo Mark
One seed interchange branching into three lens lines, drawn in `ink-fg` on an ink tile. The same geometry is used by the app and tray icons (`scripts/render-icons.cjs`).

## Do's and Don'ts

### Do:
- **Do** keep every colour tied to a state or a block type; primary actions use ink (`ink`).
- **Do** code status by shape first with station markers, then by colour.
- **Do** draw graph edges as curves in the source block's colour, and show a block type only as its round bullet.
- **Do** keep surfaces flat with hairline borders; reserve shadows for nodes, hover lift, modals and toasts.
- **Do** ship every new token in both the `:root` light set and the `prefers-color-scheme: dark` set.
- **Do** honour `prefers-reduced-motion`: animations and transitions collapse, and the running pulse, spinner and live edge stop.
- **Do** keep `.desktop` traffic-light clearance and drag regions on any new header-level bar, with `no-drag` on its controls.
- **Do** keep loudness for real blocks and must-fixes; everything else stays calm grey.

### Don't:
- **Don't** introduce a brand accent colour, a purple→teal gradient, or anything that reads as a generic AI SaaS dashboard.
- **Don't** bring back the transit-map "signage rail" direction the user rejected.
- **Don't** colour focus rings, selection, links or nav state.
- **Don't** use solid state fills where a 7–15% tint will do; must-fix is the one loud badge.
- **Don't** use motion as decoration. It reports running, live or arriving state only.
- **Don't** set uppercase letter-spaced labels or eyebrow text above titles.
