# GO-CAM Mega Editor

A modern, full-stack visual pathway editor for [GO-CAM](https://geneontology.org/docs/gocam-overview/) (Gene Ontology Causal Activity Models).

Unlike the legacy Noctua Visual Pathway Editor which works on one model at a time, this editor is designed for **interconnected mega-models** — visualizing and editing networks of GO-CAM models at the biological process level.

Think of it like Google Maps for biology: zoom out to see the full network of pathways, zoom in to edit individual activity nodes and causal connections.

![Graph view](screenshots/03-graph-view.png)

## Highlights

- **Color-coded biological processes** with interactive legend
- **Semantic zoom** — click to expand nodes and inspect evidence
- **Edit mode** — modify activities, evidence, and causal edges inline
- **Drag-to-connect** — create new causal relationships between activities
- **200+ GO-CAM models** loaded live from the Gene Ontology API

## Quick Start

```bash
git clone https://github.com/cmungall/gocam-mega-editor
cd gocam-mega-editor
just dev
```

Then open [http://localhost:5173](http://localhost:5173).

See [Getting Started](getting-started.md) for detailed setup instructions.
