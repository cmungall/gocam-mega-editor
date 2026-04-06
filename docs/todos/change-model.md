# Change Model

## Why

The editor currently treats writes as direct mutations to the GO-CAM model:

- `PATCH /model/{id}/activity/{activity_id}`
- `POST /model/{id}/causal-edge`
- `DELETE /model/{id}/causal-edge`

That is enough for basic editing, but it is a weak foundation for:

- undo / redo
- visible edit history
- reviewable edits
- comments on specific changes
- agent-authored edits
- human approval of agent changes

The long-term direction should be to make `change` a first-class object and treat the rendered model as:

`base model + applied changes`

## Goals

- Support reliable undo without reconstructing intent after mutation.
- Make edits visible as discrete objects in UI and API.
- Allow comments / review on edits, similar in spirit to GitHub review.
- Support batching changes into a proposed edit set.
- Support human and agent authorship with provenance.

## Non-Goals

- Full git-like branching on day one.
- Full text diff review.
- Replacing the current editing API immediately.

## Core Idea

Each edit should be recorded as a structured `Change` with:

- stable ID
- model ID
- author info
- timestamp
- operation type
- semantic target
- `before`
- `after`
- `inverse`
- status
- optional summary / metadata

The important constraint is that `Change` should be semantic, not a full-model snapshot.

## Candidate Change Types

- `set_enabled_by`
- `set_molecular_function`
- `set_biological_process`
- `set_occurs_in`
- `replace_evidence`
- `add_causal_edge`
- `delete_causal_edge`

## Suggested Shape

```json
{
  "id": "chg_123",
  "model_id": "5b91dbd100002241",
  "workspace_id": "default",
  "author_type": "human",
  "author_id": "cjm",
  "created_at": "2026-04-05T00:00:00Z",
  "status": "applied",
  "operation_type": "set_molecular_function",
  "target": {
    "activity_id": "gomodel:.../activity_1"
  },
  "before": {
    "term": "GO:0003674"
  },
  "after": {
    "term": "GO:0004674"
  },
  "inverse": {
    "operation_type": "set_molecular_function",
    "target": {
      "activity_id": "gomodel:.../activity_1"
    },
    "after": {
      "term": "GO:0003674"
    }
  },
  "summary": "Changed MF to protein serine/threonine kinase activity"
}
```

## Undo Model

Do not build undo as a special UI-only feature.

Instead:

- every applied change stores an inverse
- undo = apply inverse of latest applied change
- redo = reapply original change

This should work both for local user edits and persisted history.

## Review / Comments

Comments should attach to a `Change`, not to raw text lines.

Likely comment anchors:

- whole change
- field within change
- edge target
- specific evidence row

This should support GitHub-like review behavior:

- comment
- reply
- resolve
- accept / reject / revert change

## Agentic Editing

Agents should not mutate the model directly.

They should propose a `ChangeSet`:

- `id`
- `title`
- `description`
- `author_type = agent`
- `author_id`
- `changes[]`
- `status`

Then humans can inspect, comment, accept, reject, or partially apply the proposed changes.

## Recommended Incremental Plan

### Phase 1

- Keep existing mutation endpoints.
- Record every mutation as a `Change`.
- Add `GET /model/{id}/changes`.
- Add a simple history panel in the frontend.

### Phase 2

- Add `Undo Last Change`.
- Implement revert by applying stored inverse.
- Show changed nodes / edges in the graph.

### Phase 3

- Add comment threads on changes.
- Add `ChangeSet` support for grouped edits.
- Support agent-authored proposed changes.

### Phase 4

- Shift the primary write path from “mutate model” to “create/apply change”.

## Open Questions

- Where should changes live initially: in-memory, file-backed, or database-backed?
- Is undo per-model, per-user, or per-workspace?
- Do we want review on individual changes, whole change sets, or both?
- Should comments be private to a workspace or part of model provenance?
- How should accepted / rejected agent changes surface in the graph?

## Immediate Follow-Up

The next implementation step should be a minimal backend `Change` model plus an append-only change log. That gives us a concrete history surface before we add undo UI or agent workflows.
