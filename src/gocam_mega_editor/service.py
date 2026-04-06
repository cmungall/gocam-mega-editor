"""Core service layer for GO-CAM model operations.

The service owns business logic (graph translation, activity mutation).
Storage is delegated to a ModelAdapter implementation.
"""

import json
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

import networkx as nx
from gocam.datamodel import (
    Activity,
    BiologicalProcessAssociation,
    CausalAssociation,
    CellularAnatomicalEntityAssociation,
    EnabledByGeneProductAssociation,
    EvidenceItem,
    Model,
    MolecularFunctionAssociation,
    Object,
)
from gocam.translation.networkx.model_network_translator import ModelNetworkTranslator

from gocam_mega_editor.adapters import MinervaAdapter, ModelAdapter
from gocam_mega_editor.models import (
    ActivityUpdate,
    CausalEdgeCreate,
    ChangeRecord,
    ConnectedModels,
    EvidenceInput,
    GeneConnection,
    GraphEdge,
    GraphNode,
    MegaGraph,
    ModelConnections,
    ModelEdge,
    ModelNode,
    ModelSummary,
    SharedGene,
    SpeciesCluster,
)

logger = logging.getLogger(__name__)

EDITABLE_ACTIVITY_ASSOCIATIONS = (
    "enabled_by",
    "molecular_function",
    "part_of",
    "occurs_in",
)

TERM_CHANGE_FIELDS = {
    "set_enabled_by": ("enabled_by_term", "enabled_by_label"),
    "set_molecular_function": ("molecular_function_term", "molecular_function_label"),
    "set_biological_process": ("biological_process_term", "biological_process_label"),
    "set_occurs_in": ("occurs_in_term", "occurs_in_label"),
}


@dataclass
class GoCamService:
    """Service for loading, querying, and editing GO-CAM models.

    All storage is delegated to the adapter. The service handles
    graph translation, activity mutation, and response formatting.
    """

    adapter: ModelAdapter = field(default_factory=MinervaAdapter)
    translator: ModelNetworkTranslator = field(default_factory=ModelNetworkTranslator)
    summary_cache: dict[str, ModelSummary] | None = None
    change_log: dict[str, list[ChangeRecord]] = field(default_factory=dict)
    change_log_dir: Path | None = None
    _generated_change_metadata: dict[str, Any] | None = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        if self.change_log_dir is not None:
            self.change_log_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _summary_from_entry(entry: dict) -> ModelSummary | None:
        gocam_url = entry.get("gocam", "")
        if not gocam_url:
            return None

        model_id = (
            gocam_url.replace("http://model.geneontology.org/", "")
            .replace("https://model.geneontology.org/", "")
        )

        return ModelSummary(
            id=model_id,
            title=entry.get("title", ""),
            taxon=entry.get("taxon"),
            status=entry.get("state"),
            date=entry.get("date"),
            contributors=entry.get("names", []),
            groups=entry.get("groupnames", []),
            activity_count=0,
        )

    def _load_summary_cache(self) -> dict[str, ModelSummary]:
        if self.summary_cache is not None:
            return self.summary_cache

        cache: dict[str, ModelSummary] = {}
        offset = 0
        limit = 1000

        while True:
            entries = self.adapter.list_summaries(limit=limit, offset=offset)
            if not entries:
                break
            for entry in entries:
                summary = self._summary_from_entry(entry)
                if summary is not None:
                    cache[summary.id] = summary
            if len(entries) < limit:
                break
            offset += limit

        self.summary_cache = cache
        return cache

    def list_models(self, limit: int = 100, offset: int = 0) -> list[ModelSummary]:
        """List available GO-CAM models from the adapter."""
        entries = self.adapter.list_summaries(limit=limit, offset=offset)
        summaries = [summary for entry in entries if (summary := self._summary_from_entry(entry)) is not None]
        return summaries

    def get_model_summary(self, model_id: str) -> ModelSummary | None:
        """Return listing/index metadata for a specific model if available."""
        return self._load_summary_cache().get(model_id)

    def get_model(self, model_id: str) -> Model:
        """Fetch a single GO-CAM model via the adapter."""
        model = self.adapter.get(model_id)
        if model is None:
            raise ValueError(f"Model {model_id} not found")
        return model

    def _find_activity(self, model: Model, activity_id: str) -> Activity:
        """Find an activity by ID within a model, or raise ValueError."""
        for activity in model.activities or []:
            if activity.id == activity_id:
                return activity
        raise ValueError(f"Activity {activity_id} not found in model {model.id}")

    @staticmethod
    def _build_evidence(inputs: list[EvidenceInput]) -> list[EvidenceItem]:
        return [
            EvidenceItem(
                term=ev.term,
                reference=ev.reference,
                with_objects=ev.with_objects,
            )
            for ev in inputs
        ]

    @staticmethod
    def _current_evidence(activity: Activity, association_name: str) -> list[EvidenceItem] | None:
        association = getattr(activity, association_name, None)
        return association.evidence if association else None

    @staticmethod
    def _apply_shared_evidence(activity: Activity, evidence: list[EvidenceItem]) -> None:
        for association_name in EDITABLE_ACTIVITY_ASSOCIATIONS:
            association = getattr(activity, association_name, None)
            if association is not None:
                association.evidence = evidence

    def _serialize_evidence(self, model: Model, evidence: list[EvidenceItem] | None) -> list[dict] | None:
        if evidence is None:
            return None
        serialized: list[dict] = []
        for item in evidence:
            payload = item.model_dump(exclude_none=True)
            label = self._resolve_object_label(model, item.term)
            if label:
                payload["term_label"] = label
            serialized.append(payload)
        return serialized

    @staticmethod
    def _resolve_object_label(model: Model, term_id: str | None) -> str | None:
        if not term_id or not model.objects:
            return None
        for obj in model.objects:
            if obj.id == term_id:
                return obj.label
        return None

    @staticmethod
    def _upsert_object_label(model: Model, term_id: str | None, label: str | None) -> None:
        if not term_id or not label or label == term_id:
            return
        if model.objects is None:
            model.objects = []
        for obj in model.objects:
            if obj.id == term_id:
                obj.label = label
                return
        model.objects.append(Object(id=term_id, label=label))

    def _term_snapshot(self, model: Model, term_id: str | None, label: str | None = None) -> dict[str, str | None]:
        resolved_label = label or self._resolve_object_label(model, term_id)
        return {
            "term": term_id,
            "label": resolved_label,
        }

    def _shared_evidence_snapshot(self, model: Model, activity: Activity) -> list[dict] | None:
        for association_name in EDITABLE_ACTIVITY_ASSOCIATIONS:
            association = getattr(activity, association_name, None)
            if association is not None and association.evidence is not None:
                return self._serialize_evidence(model, association.evidence)
        return None

    @staticmethod
    def _activity_change_summary(
        field_label: str,
        activity_id: str,
        before_label: str | None,
        after_label: str | None,
    ) -> str:
        short_id = activity_id.split("/")[-1]
        if before_label and after_label:
            return f"Changed {field_label} on {short_id}: {before_label} -> {after_label}"
        if after_label:
            return f"Set {field_label} on {short_id}: {after_label}"
        if before_label:
            return f"Cleared {field_label} on {short_id}: {before_label}"
        return f"Cleared {field_label} on {short_id}"

    def _record_change(
        self,
        model_id: str,
        operation_type: str,
        target: dict,
        before: dict | None,
        after: dict | None,
        inverse: dict | None,
        summary: str,
        metadata: dict | None = None,
    ) -> ChangeRecord:
        self._load_persisted_changes(model_id)
        combined_metadata = dict(self._generated_change_metadata or {})
        if metadata:
            combined_metadata.update(metadata)
        if not combined_metadata:
            self._clear_redo_candidates(model_id)
        record = ChangeRecord(
            id=f"chg_{uuid4().hex[:12]}",
            model_id=model_id,
            created_at=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            operation_type=operation_type,
            target=target,
            before=before,
            after=after,
            inverse=inverse,
            summary=summary,
            metadata=combined_metadata or None,
        )
        self.change_log.setdefault(model_id, []).append(record)
        self._persist_changes(model_id)
        return record

    def get_model_changes(self, model_id: str) -> list[ChangeRecord]:
        """Return recorded semantic changes for a model."""
        self.get_model(model_id)
        self._load_persisted_changes(model_id)
        return list(self.change_log.get(model_id, []))

    def _change_log_path(self, model_id: str) -> Path | None:
        if self.change_log_dir is None:
            return None
        safe_id = model_id.replace("/", "_").replace(":", "_")
        return self.change_log_dir / f"{safe_id}.json"

    def _load_persisted_changes(self, model_id: str) -> None:
        if model_id in self.change_log or self.change_log_dir is None:
            return
        path = self._change_log_path(model_id)
        if path is None or not path.exists():
            return
        payload = json.loads(path.read_text())
        self.change_log[model_id] = [ChangeRecord(**item) for item in payload]

    def _persist_changes(self, model_id: str) -> None:
        path = self._change_log_path(model_id)
        if path is None:
            return
        payload = [change.model_dump(exclude_none=True) for change in self.change_log.get(model_id, [])]
        path.write_text(json.dumps(payload, indent=2))

    @staticmethod
    def _is_generated_change(change: ChangeRecord) -> bool:
        generated_by = (change.metadata or {}).get("generated_by")
        return isinstance(generated_by, str) and generated_by in {"undo", "redo"}

    def _clear_redo_candidates(self, model_id: str) -> None:
        dirty = False
        for change in self.change_log.get(model_id, []):
            if self._is_generated_change(change):
                continue
            metadata = dict(change.metadata or {})
            if metadata.get("redo_available"):
                metadata["redo_available"] = False
                change.metadata = metadata
                dirty = True
        if dirty:
            self._persist_changes(model_id)

    def _find_change(self, model_id: str, change_id: str) -> ChangeRecord:
        self.get_model(model_id)
        self._load_persisted_changes(model_id)
        for change in self.change_log.get(model_id, []):
            if change.id == change_id:
                return change
        raise ValueError(f"Change {change_id} not found for model {model_id}")

    def _latest_applied_change(self, model_id: str) -> ChangeRecord:
        self.get_model(model_id)
        self._load_persisted_changes(model_id)
        for change in reversed(self.change_log.get(model_id, [])):
            if not self._is_generated_change(change) and change.status == "applied":
                return change
        raise ValueError(f"No applied changes available for model {model_id}")

    def _latest_redoable_change(self, model_id: str) -> ChangeRecord:
        self.get_model(model_id)
        self._load_persisted_changes(model_id)
        changes = self.change_log.get(model_id, [])
        index_by_id = {change.id: index for index, change in enumerate(changes)}

        redoable = [
            change for change in changes
            if not self._is_generated_change(change)
            and change.status == "reverted"
            and bool((change.metadata or {}).get("redo_available"))
        ]
        if not redoable:
            raise ValueError(f"No reverted changes available to redo for model {model_id}")

        def reverted_order(change: ChangeRecord) -> int:
            reverted_by_change_id = (change.metadata or {}).get("reverted_by_change_id")
            if isinstance(reverted_by_change_id, str):
                return index_by_id.get(reverted_by_change_id, -1)
            return -1

        return max(redoable, key=reverted_order)

    @staticmethod
    def _evidence_inputs_from_snapshot(value: object) -> list[EvidenceInput]:
        if not isinstance(value, list):
            return []
        evidence_inputs: list[EvidenceInput] = []
        for item in value:
            if not isinstance(item, dict):
                continue
            evidence_inputs.append(
                EvidenceInput(
                    term=item.get("term"),
                    term_label=item.get("term_label"),
                    reference=item.get("reference"),
                    with_objects=item.get("with_objects"),
                )
            )
        return evidence_inputs

    def _build_revert_activity_update(self, change: ChangeRecord) -> ActivityUpdate:
        inverse = change.inverse or {}

        if change.operation_type in TERM_CHANGE_FIELDS:
            term_key, label_key = TERM_CHANGE_FIELDS[change.operation_type]
            before = change.before or {}
            before_term = before.get("term") if isinstance(before, dict) else None
            before_label = before.get("label") if isinstance(before, dict) else None
            return ActivityUpdate(
                **{
                    term_key: inverse.get(term_key) if inverse.get(term_key) is not None else (before_term or ""),
                    label_key: inverse.get(label_key) if inverse.get(label_key) is not None else before_label,
                }
            )

        if change.operation_type == "replace_evidence":
            raw_evidence = inverse.get("evidence") if isinstance(inverse, dict) else []
            return ActivityUpdate(
                evidence=self._evidence_inputs_from_snapshot([] if raw_evidence is None else raw_evidence)
            )

        raise ValueError(f"Unsupported activity revert operation: {change.operation_type}")

    def _build_forward_activity_update(self, change: ChangeRecord) -> ActivityUpdate:
        if change.operation_type not in TERM_CHANGE_FIELDS and change.operation_type != "replace_evidence":
            raise ValueError(f"Unsupported activity redo operation: {change.operation_type}")

        if change.operation_type in TERM_CHANGE_FIELDS:
            term_key, label_key = TERM_CHANGE_FIELDS[change.operation_type]
            after = change.after or {}
            after_term = after.get("term") if isinstance(after, dict) else None
            after_label = after.get("label") if isinstance(after, dict) else None
            return ActivityUpdate(
                **{
                    term_key: after_term or "",
                    label_key: after_label,
                }
            )

        raw_evidence = (change.after or {}).get("evidence") if isinstance(change.after, dict) else []
        return ActivityUpdate(
            evidence=self._evidence_inputs_from_snapshot([] if raw_evidence is None else raw_evidence)
        )

    def _apply_inverse(self, model_id: str, change: ChangeRecord) -> ChangeRecord:
        change_list = self.change_log.setdefault(model_id, [])
        before_count = len(change_list)

        previous_metadata = self._generated_change_metadata
        self._generated_change_metadata = {
            "generated_by": "undo",
            "reverts_change_id": change.id,
            "origin_change_id": change.id,
        }
        try:
            if change.operation_type in TERM_CHANGE_FIELDS or change.operation_type == "replace_evidence":
                target_activity_id = change.target.get("activity_id")
                if not isinstance(target_activity_id, str):
                    raise ValueError(f"Change {change.id} is missing a valid activity target")
                self.update_activity(model_id, target_activity_id, self._build_revert_activity_update(change))
            elif change.operation_type == "add_causal_edge":
                inverse = change.inverse or {}
                source_activity_id = inverse.get("source_activity_id")
                target_activity_id = inverse.get("target_activity_id")
                predicate = inverse.get("predicate")
                if not all(isinstance(value, str) for value in (source_activity_id, target_activity_id, predicate)):
                    raise ValueError(f"Change {change.id} is missing edge inverse data")
                removed = self.delete_causal_edge(model_id, source_activity_id, target_activity_id, predicate)
                if not removed:
                    raise ValueError(f"Unable to revert change {change.id}; edge was not present")
            elif change.operation_type == "delete_causal_edge":
                inverse = change.inverse or {}
                source_activity_id = inverse.get("source_activity_id")
                target_activity_id = inverse.get("target_activity_id")
                predicate = inverse.get("predicate")
                if not all(isinstance(value, str) for value in (source_activity_id, target_activity_id, predicate)):
                    raise ValueError(f"Change {change.id} is missing edge inverse data")
                self.add_causal_edge(
                    model_id,
                    CausalEdgeCreate(
                        source_activity_id=source_activity_id,
                        target_activity_id=target_activity_id,
                        predicate=predicate,
                    ),
                )
            else:
                raise ValueError(f"Unsupported revert operation for {change.operation_type}")
        finally:
            self._generated_change_metadata = previous_metadata

        new_changes = change_list[before_count:]
        if not new_changes:
            raise ValueError(f"Change {change.id} produced no inverse operation")
        return new_changes[-1]

    def _apply_forward(self, model_id: str, change: ChangeRecord) -> ChangeRecord:
        change_list = self.change_log.setdefault(model_id, [])
        before_count = len(change_list)

        previous_metadata = self._generated_change_metadata
        self._generated_change_metadata = {
            "generated_by": "redo",
            "redoes_change_id": change.id,
            "origin_change_id": change.id,
        }
        try:
            if change.operation_type in TERM_CHANGE_FIELDS or change.operation_type == "replace_evidence":
                target_activity_id = change.target.get("activity_id")
                if not isinstance(target_activity_id, str):
                    raise ValueError(f"Change {change.id} is missing a valid activity target")
                self.update_activity(model_id, target_activity_id, self._build_forward_activity_update(change))
            elif change.operation_type == "add_causal_edge":
                target = change.target or {}
                source_activity_id = target.get("source_activity_id")
                target_activity_id = target.get("target_activity_id")
                predicate = target.get("predicate")
                if not all(isinstance(value, str) for value in (source_activity_id, target_activity_id, predicate)):
                    raise ValueError(f"Change {change.id} is missing edge target data")
                self.add_causal_edge(
                    model_id,
                    CausalEdgeCreate(
                        source_activity_id=source_activity_id,
                        target_activity_id=target_activity_id,
                        predicate=predicate,
                    ),
                )
            elif change.operation_type == "delete_causal_edge":
                target = change.target or {}
                source_activity_id = target.get("source_activity_id")
                target_activity_id = target.get("target_activity_id")
                predicate = target.get("predicate")
                if not all(isinstance(value, str) for value in (source_activity_id, target_activity_id, predicate)):
                    raise ValueError(f"Change {change.id} is missing edge target data")
                removed = self.delete_causal_edge(model_id, source_activity_id, target_activity_id, predicate)
                if not removed:
                    raise ValueError(f"Unable to redo change {change.id}; edge was not present")
            else:
                raise ValueError(f"Unsupported redo operation for {change.operation_type}")
        finally:
            self._generated_change_metadata = previous_metadata

        new_changes = change_list[before_count:]
        if not new_changes:
            raise ValueError(f"Change {change.id} produced no forward operation")
        return new_changes[-1]

    def _mark_change_reverted(self, model_id: str, original: ChangeRecord, revert_change: ChangeRecord) -> None:
        original.status = "reverted"
        original_metadata = dict(original.metadata or {})
        original_metadata["reverted_by_change_id"] = revert_change.id
        original_metadata["redo_available"] = True
        original.metadata = original_metadata

        revert_metadata = dict(revert_change.metadata or {})
        revert_metadata["reverts_change_id"] = original.id
        revert_change.metadata = revert_metadata

        self._persist_changes(model_id)

    def revert_change(self, model_id: str, change_id: str) -> ChangeRecord:
        change = self._find_change(model_id, change_id)
        if self._is_generated_change(change):
            raise ValueError(f"Generated change {change_id} cannot be reverted directly")
        if change.status != "applied":
            raise ValueError(f"Change {change_id} is already reverted")
        revert_change = self._apply_inverse(model_id, change)
        self._mark_change_reverted(model_id, change, revert_change)
        return revert_change

    def undo_last_change(self, model_id: str) -> ChangeRecord:
        change = self._latest_applied_change(model_id)
        return self.revert_change(model_id, change.id)

    def redo_last_change(self, model_id: str) -> ChangeRecord:
        change = self._latest_redoable_change(model_id)
        redo_change = self._apply_forward(model_id, change)

        change.status = "applied"
        metadata = dict(change.metadata or {})
        metadata["redo_available"] = False
        metadata["redone_by_change_id"] = redo_change.id
        change.metadata = metadata

        redo_metadata = dict(redo_change.metadata or {})
        redo_metadata["redoes_change_id"] = change.id
        redo_change.metadata = redo_metadata

        self._persist_changes(model_id)
        return redo_change

    def update_activity(self, model_id: str, activity_id: str, update: ActivityUpdate) -> Activity:
        """Apply a partial update to an activity, then persist via adapter."""
        model = self.get_model(model_id)
        activity = self._find_activity(model, activity_id)
        before_terms = {
            "enabled_by": activity.enabled_by.term if activity.enabled_by else None,
            "molecular_function": activity.molecular_function.term if activity.molecular_function else None,
            "part_of": activity.part_of.term if activity.part_of else None,
            "occurs_in": activity.occurs_in.term if activity.occurs_in else None,
        }
        before_snapshots = {
            "enabled_by": self._term_snapshot(model, before_terms["enabled_by"]),
            "molecular_function": self._term_snapshot(model, before_terms["molecular_function"]),
            "part_of": self._term_snapshot(model, before_terms["part_of"]),
            "occurs_in": self._term_snapshot(model, before_terms["occurs_in"]),
        }
        before_evidence = self._shared_evidence_snapshot(model, activity)
        evidence = self._build_evidence(update.evidence) if update.evidence is not None else None

        if update.enabled_by_term is not None:
            self._upsert_object_label(model, update.enabled_by_term, update.enabled_by_label)
            activity.enabled_by = (
                EnabledByGeneProductAssociation(
                    term=update.enabled_by_term,
                    evidence=evidence if update.evidence is not None else self._current_evidence(activity, "enabled_by"),
                )
                if update.enabled_by_term
                else None
            )
        if update.molecular_function_term is not None:
            self._upsert_object_label(model, update.molecular_function_term, update.molecular_function_label)
            activity.molecular_function = (
                MolecularFunctionAssociation(
                    term=update.molecular_function_term,
                    evidence=evidence if update.evidence is not None else self._current_evidence(activity, "molecular_function"),
                )
                if update.molecular_function_term
                else None
            )
        if update.biological_process_term is not None:
            self._upsert_object_label(model, update.biological_process_term, update.biological_process_label)
            activity.part_of = (
                BiologicalProcessAssociation(
                    term=update.biological_process_term,
                    evidence=evidence if update.evidence is not None else self._current_evidence(activity, "part_of"),
                )
                if update.biological_process_term
                else None
            )
        if update.occurs_in_term is not None:
            self._upsert_object_label(model, update.occurs_in_term, update.occurs_in_label)
            activity.occurs_in = (
                CellularAnatomicalEntityAssociation(
                    term=update.occurs_in_term,
                    evidence=evidence if update.evidence is not None else self._current_evidence(activity, "occurs_in"),
                )
                if update.occurs_in_term
                else None
            )
        if update.evidence is not None:
            for evidence_input in update.evidence:
                self._upsert_object_label(model, evidence_input.term, evidence_input.term_label)
            self._apply_shared_evidence(activity, evidence)

        self.adapter.save(model)

        if update.enabled_by_term is not None and update.enabled_by_term != before_terms["enabled_by"]:
            after_term = activity.enabled_by.term if activity.enabled_by else None
            after_snapshot = self._term_snapshot(model, after_term, update.enabled_by_label)
            self._record_change(
                model_id=model_id,
                operation_type="set_enabled_by",
                target={"activity_id": activity_id, "field": "enabled_by"},
                before=before_snapshots["enabled_by"],
                after=after_snapshot,
                inverse={
                    "enabled_by_term": before_terms["enabled_by"] or "",
                    "enabled_by_label": before_snapshots["enabled_by"]["label"],
                },
                summary=self._activity_change_summary(
                    "gene product",
                    activity_id,
                    before_snapshots["enabled_by"]["label"] or before_terms["enabled_by"],
                    after_snapshot["label"] or after_term,
                ),
            )
        if update.molecular_function_term is not None and update.molecular_function_term != before_terms["molecular_function"]:
            after_term = activity.molecular_function.term if activity.molecular_function else None
            after_snapshot = self._term_snapshot(model, after_term, update.molecular_function_label)
            self._record_change(
                model_id=model_id,
                operation_type="set_molecular_function",
                target={"activity_id": activity_id, "field": "molecular_function"},
                before=before_snapshots["molecular_function"],
                after=after_snapshot,
                inverse={
                    "molecular_function_term": before_terms["molecular_function"] or "",
                    "molecular_function_label": before_snapshots["molecular_function"]["label"],
                },
                summary=self._activity_change_summary(
                    "molecular function",
                    activity_id,
                    before_snapshots["molecular_function"]["label"] or before_terms["molecular_function"],
                    after_snapshot["label"] or after_term,
                ),
            )
        if update.biological_process_term is not None and update.biological_process_term != before_terms["part_of"]:
            after_term = activity.part_of.term if activity.part_of else None
            after_snapshot = self._term_snapshot(model, after_term, update.biological_process_label)
            self._record_change(
                model_id=model_id,
                operation_type="set_biological_process",
                target={"activity_id": activity_id, "field": "part_of"},
                before=before_snapshots["part_of"],
                after=after_snapshot,
                inverse={
                    "biological_process_term": before_terms["part_of"] or "",
                    "biological_process_label": before_snapshots["part_of"]["label"],
                },
                summary=self._activity_change_summary(
                    "biological process",
                    activity_id,
                    before_snapshots["part_of"]["label"] or before_terms["part_of"],
                    after_snapshot["label"] or after_term,
                ),
            )
        if update.occurs_in_term is not None and update.occurs_in_term != before_terms["occurs_in"]:
            after_term = activity.occurs_in.term if activity.occurs_in else None
            after_snapshot = self._term_snapshot(model, after_term, update.occurs_in_label)
            self._record_change(
                model_id=model_id,
                operation_type="set_occurs_in",
                target={"activity_id": activity_id, "field": "occurs_in"},
                before=before_snapshots["occurs_in"],
                after=after_snapshot,
                inverse={
                    "occurs_in_term": before_terms["occurs_in"] or "",
                    "occurs_in_label": before_snapshots["occurs_in"]["label"],
                },
                summary=self._activity_change_summary(
                    "cellular component",
                    activity_id,
                    before_snapshots["occurs_in"]["label"] or before_terms["occurs_in"],
                    after_snapshot["label"] or after_term,
                ),
            )
        if update.evidence is not None:
            after_evidence = self._shared_evidence_snapshot(model, activity)
            if after_evidence != before_evidence:
                target_associations = [
                    name for name in EDITABLE_ACTIVITY_ASSOCIATIONS if getattr(activity, name, None) is not None
                ]
                self._record_change(
                    model_id=model_id,
                    operation_type="replace_evidence",
                    target={"activity_id": activity_id, "fields": target_associations},
                    before={"evidence": before_evidence},
                    after={"evidence": after_evidence},
                    inverse={"evidence": before_evidence if before_evidence is not None else []},
                    summary=f"Replaced shared evidence on {activity_id.split('/')[-1]}",
                )
        return activity

    def add_causal_edge(self, model_id: str, edge: CausalEdgeCreate) -> CausalAssociation:
        """Add a causal association between two activities, then persist."""
        model = self.get_model(model_id)
        source = self._find_activity(model, edge.source_activity_id)
        self._find_activity(model, edge.target_activity_id)

        assoc = CausalAssociation(
            predicate=edge.predicate,
            downstream_activity=edge.target_activity_id,
        )
        if source.causal_associations is None:
            source.causal_associations = []
        source.causal_associations.append(assoc)

        self.adapter.save(model)
        self._record_change(
            model_id=model_id,
            operation_type="add_causal_edge",
            target={
                "source_activity_id": edge.source_activity_id,
                "target_activity_id": edge.target_activity_id,
                "predicate": edge.predicate,
            },
            before=None,
            after={
                "predicate": edge.predicate,
                "downstream_activity": edge.target_activity_id,
            },
            inverse={
                "source_activity_id": edge.source_activity_id,
                "target_activity_id": edge.target_activity_id,
                "predicate": edge.predicate,
            },
            summary=(
                f"Added causal edge {edge.source_activity_id.split('/')[-1]} -> "
                f"{edge.target_activity_id.split('/')[-1]} ({edge.predicate})"
            ),
        )
        return assoc

    def delete_causal_edge(
        self,
        model_id: str,
        source_activity_id: str,
        target_activity_id: str,
        predicate: str | None = None,
    ) -> list[CausalAssociation]:
        """Remove a causal association between two activities, then persist."""
        model = self.get_model(model_id)
        source = self._find_activity(model, source_activity_id)
        removed: list[CausalAssociation] = []
        if source.causal_associations:
            remaining = []
            for ca in source.causal_associations:
                should_remove = ca.downstream_activity == target_activity_id and (
                    predicate is None or ca.predicate == predicate
                )
                if should_remove:
                    removed.append(ca)
                else:
                    remaining.append(ca)
            source.causal_associations = remaining
        self.adapter.save(model)
        for removed_assoc in removed:
            self._record_change(
                model_id=model_id,
                operation_type="delete_causal_edge",
                target={
                    "source_activity_id": source_activity_id,
                    "target_activity_id": target_activity_id,
                    "predicate": removed_assoc.predicate,
                },
                before={
                    "predicate": removed_assoc.predicate,
                    "downstream_activity": removed_assoc.downstream_activity,
                },
                after=None,
                inverse={
                    "source_activity_id": source_activity_id,
                    "target_activity_id": target_activity_id,
                    "predicate": removed_assoc.predicate,
                },
                summary=(
                    f"Deleted causal edge {source_activity_id.split('/')[-1]} -> "
                    f"{target_activity_id.split('/')[-1]} ({removed_assoc.predicate})"
                ),
            )
        return removed

    def get_model_connections(self, model_id: str) -> ModelConnections:
        """Find which gene products in this model also appear in other models.

        Only considers same-species models.
        """
        model = self.get_model(model_id)
        taxon = model.taxon

        # Collect this model's gene products
        my_genes: dict[str, str | None] = {}
        for act in model.activities or []:
            if act.enabled_by and act.enabled_by.term:
                gene = act.enabled_by.term
                label = None
                if model.objects:
                    for obj in model.objects:
                        if obj.id == gene and obj.label:
                            label = obj.label
                            break
                my_genes[gene] = label

        # Scan other models for matches
        gene_other_models: dict[str, list[ModelSummary]] = defaultdict(list)
        for other_id in self.adapter.list_ids():
            if other_id == model_id:
                continue
            other = self.adapter.get(other_id)
            if not other or other.taxon != taxon:
                continue
            other_genes = {
                act.enabled_by.term
                for act in (other.activities or [])
                if act.enabled_by and act.enabled_by.term
            }
            shared = other_genes & my_genes.keys()
            if shared:
                summary = ModelSummary(
                    id=other_id,
                    title=other.title or other_id,
                    taxon=other.taxon,
                    activity_count=len(other.activities or []),
                )
                for gene in shared:
                    gene_other_models[gene].append(summary)

        connections = [
            GeneConnection(
                gene_id=gene,
                label=my_genes.get(gene),
                other_models=models,
            )
            for gene, models in sorted(gene_other_models.items(), key=lambda x: len(x[1]), reverse=True)
        ]

        return ModelConnections(model_id=model_id, connections=connections)

    def find_connected_models(self, model_ids: list[str] | None = None) -> ConnectedModels:
        """Find models that share gene products, grouped by species.

        Only same-species gene sharing counts as a real connection.
        """
        if model_ids is None:
            model_ids = self.adapter.list_ids()

        # Collect model metadata + gene->model mapping
        model_info: dict[str, dict] = {}
        gene_to_models: dict[str, list[str]] = defaultdict(list)
        gene_labels: dict[str, str] = {}

        for mid in model_ids:
            model = self.adapter.get(mid)
            if not model:
                continue
            taxon = model.taxon
            # Resolve taxon label
            taxon_label = None
            if taxon and model.objects:
                for obj in model.objects:
                    if obj.id == taxon and obj.label:
                        taxon_label = obj.label
                        break
            model_info[mid] = {
                "title": model.title or mid,
                "taxon": taxon,
                "taxon_label": taxon_label,
                "activity_count": len(model.activities or []),
            }
            for act in model.activities or []:
                if act.enabled_by and act.enabled_by.term:
                    gene = act.enabled_by.term
                    gene_to_models[gene].append(mid)
                    if gene not in gene_labels and model.objects:
                        for obj in model.objects:
                            if obj.id == gene and obj.label:
                                gene_labels[gene] = obj.label
                                break

        # Group models by species
        species_models: dict[str | None, list[str]] = defaultdict(list)
        for mid, info in model_info.items():
            species_models[info["taxon"]].append(mid)

        # Build per-species clusters
        clusters: list[SpeciesCluster] = []
        total_connections = 0

        for taxon, mids in sorted(species_models.items(), key=lambda x: len(x[1]), reverse=True):
            mid_set = set(mids)
            # Find model-to-model edges via shared genes (same species only)
            pair_genes: dict[tuple[str, str], list[SharedGene]] = defaultdict(list)
            for gene, gene_mids in gene_to_models.items():
                same_species = [m for m in gene_mids if m in mid_set]
                unique = sorted(set(same_species))
                if len(unique) < 2:
                    continue
                sg = SharedGene(gene_id=gene, label=gene_labels.get(gene), model_ids=unique)
                from itertools import combinations
                for a, b in combinations(unique, 2):
                    pair_genes[(a, b)].append(sg)

            edges = [
                ModelEdge(
                    source=a,
                    target=b,
                    shared_genes=genes,
                    weight=len(genes),
                )
                for (a, b), genes in sorted(pair_genes.items(), key=lambda x: len(x[1]), reverse=True)
            ]

            # Only include models that have connections (or all if no connections)
            connected_mids = {m for e in edges for m in (e.source, e.target)}
            include_mids = connected_mids if connected_mids else set(mids)

            nodes = [
                ModelNode(
                    id=mid,
                    title=model_info[mid]["title"],
                    taxon=model_info[mid]["taxon"],
                    activity_count=model_info[mid]["activity_count"],
                )
                for mid in sorted(include_mids)
            ]

            taxon_label = None
            if mids and model_info[mids[0]].get("taxon_label"):
                taxon_label = model_info[mids[0]]["taxon_label"]

            total_connections += len(edges)
            clusters.append(
                SpeciesCluster(
                    taxon=taxon,
                    taxon_label=taxon_label,
                    models=nodes,
                    edges=edges,
                )
            )

        return ConnectedModels(
            species_clusters=clusters,
            total_models=len(model_info),
            total_connections=total_connections,
        )

    def get_mega_graph(self, model_ids: list[str]) -> MegaGraph:
        """Build an interconnected graph from multiple models."""
        models = [self.get_model(mid) for mid in model_ids]
        nx_graph: nx.DiGraph = self.translator.translate_models(models)

        nodes = []
        for node_id, attrs in nx_graph.nodes(data=True):
            nodes.append(
                GraphNode(
                    id=str(node_id),
                    label=attrs.get("label"),
                    gene_product=attrs.get("gene_product"),
                    model_id=attrs.get("model_id"),
                )
            )

        edges = []
        for src, tgt, attrs in nx_graph.edges(data=True):
            edges.append(
                GraphEdge(
                    source=str(src),
                    target=str(tgt),
                    causal_predicate=attrs.get("causal_predicate"),
                    model_id=attrs.get("model_id"),
                )
            )

        return MegaGraph(
            nodes=nodes,
            edges=edges,
            model_count=len(models),
            node_count=len(nodes),
            edge_count=len(edges),
        )
