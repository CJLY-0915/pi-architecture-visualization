---
name: Draw.io
description: Use only for an explicit editable-delivery request such as a .drawio file, diagrams.net, or a direct ask to edit the diagram in Draw.io. Writes Draw.io XML derived from the canonical architecture model, which stays the source of truth.
---

# Draw.io

A delivery foundation, not a scenario. It applies only when the user explicitly asks for an editable Draw.io artifact — a `.drawio` file, diagrams.net, or "I need to edit this in Draw.io". A generic "make me an architecture diagram" routes to a scenario skill first; the delivery format is decided afterwards.

## What this host actually offers

Be precise, or the user waits for a surface that does not exist:

- PI-Desktop has no Draw.io MCP server and no Draw.io renderer in this plugin. Nothing here opens, renders or edits a diagram.
- The deliverable is an XML file written to disk by you, inside the target project's workspace. The user opens it in Draw.io or diagrams.net themselves.
- The plugin's in-panel export preview covers Draw.io XML as a text preview only. It does not save, download or write anything, and it is not an editing surface.
- The exported XML carries `nodes` and `edges`: one `mxCell` per node (`id="n:<nodeId>"`) and per edge (`id="e:<edgeId>"`), a single diagram page, a deterministic grid layout, node names as labels and edge types as edge labels. A fact that is not `confirmed`/`high` is marked three ways in the file: a ` [status · confidence]` label suffix, a status fill colour (confirmed=blue, inferred=amber, assumed=orange, unknown=grey) and a dashed outline, with the rule restated in an XML comment. Evidence bodies and the declared `unknowns`, `findings`, `decisions` and `migrationSlices` collections are not expressed in the XML, and the layout needs manual arrangement after import.

## Canonical and derived

The evidence model — `architecture/model.json`, or the text diagram source when no model exists — stays canonical. The `.drawio` file is derived and editable, which means it can be edited into something false.

Every manual fact change made in Draw.io — a renamed service, a new dependency, a removed edge — must be written back into the model, with its evidence, before the model is regenerated. If the model is not updated, the next export silently reverts the correction. Report the round trip: what changed in Draw.io, what changed in the model, and what evidence supports it.

## Workflow

1. Get the model first — `system-modeler`, or the scenario skill that fits the question. Run `architecture_validate` on it.
2. Derive the Draw.io XML from that model, keeping `n:<nodeId>` and `e:<edgeId>` cell ids so a shape can be traced back to a node. Uncertainty is already in the file — check that the marks survived instead of adding your own.
3. Write `<name>.drawio` to disk. Say what it contains and what it omits.
4. When the user edits it, fold the fact changes back into the model and re-validate.

Keep the file self-describing: a header comment or a companion note naming the model path, its `sourceRevision`, `generatedAt` and `coverage`, so a reader later knows which model the picture came from.

## Quality rules

- Preserve node and edge ids through the conversion. An id is the only link back to evidence.
- Mark low-confidence, assumed and unknown facts visibly in the file — a label suffix, a color, or a note. An editable file must not imply more certainty than the model claims. The exporter already does this (label suffix, status fill colour, dashed outline); your job is to verify the marks survived, not to add a second set by hand.
- Do not hand-place facts the model does not contain. Draw.io is where layout goes, not new architecture.
- Do not promise a live editing surface, an MCP round trip, or a re-import that updates the model. None of that exists here.
- Regenerate rather than patch. Two hand-edited copies of one diagram are two sources of truth.

## Do not

- Do not route a broad architecture request here. Route by scenario; `drawio` only decides the delivery format.
- Do not add a Draw.io dependency, MCP server or renderer to the plugin.
- Do not replace the canonical model with the `.drawio` file, and do not treat the file as evidence.
