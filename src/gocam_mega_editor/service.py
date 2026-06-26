"""Core service layer for GO-CAM model operations.

The service owns business logic (graph translation, activity mutation).
Storage is delegated to a ModelAdapter implementation.
"""

import json
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from itertools import combinations
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
    ModelLinkAnchor,
    ModelLinkCriterion,
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

CRITERION_DEFS = {
    "shared_gene": ("Shared gene", "weak", 10),
    "gene_mf": ("Shared gene + MF", "medium", 35),
    "full_activity_signature": ("Shared gene + MF + BP + CC", "strong", 80),
    "terminal_to_initial": ("Terminal-to-initial overlap", "strong", 70),
    "shared_chemical": ("Shared non-currency chemical", "weak", 20),
    "chemical_flow": ("Chemical output-to-input flow", "strong", 60),
}

INPUT_MOLECULE_PREDICATES = {"RO:0002233"}
OUTPUT_MOLECULE_PREDICATES = {"RO:0002234"}

CURRENCY_CHEBI_IDS = {
    "CHEBI:15377",  # water
    "CHEBI:15378",  # hydron
    "CHEBI:15379",  # dioxygen
    "CHEBI:16526",  # carbon dioxide
    "CHEBI:18367",  # phosphate
    "CHEBI:24636",  # proton
    "CHEBI:29101",  # sodium(1+)
    "CHEBI:29103",  # potassium(1+)
    "CHEBI:29108",  # calcium(2+)
    "CHEBI:30616",  # ATP
    "CHEBI:456216",  # ADP
    "CHEBI:456215",  # AMP
    "CHEBI:57540",  # NAD(+)
    "CHEBI:57945",  # NADH
    "CHEBI:58349",  # NADP(+)
    "CHEBI:57783",  # NADPH
}

ANCHOR_SAMPLE_LIMIT = 5


@dataclass(frozen=True)
class ActivityLinkRef:
    model_id: str
    activity_id: str
    gene_id: str | None = None
    gene_label: str | None = None
    molecular_function: str | None = None
    biological_process: str | None = None
    cellular_component: str | None = None
    molecule_id: str | None = None
    molecule_label: str | None = None
    role: str | None = None


@dataclass
class CriterionAccumulator:
    type: str
    label: str
    strength: str
    base_score: int
    count: int = 0
    anchors: list[ModelLinkAnchor] = field(default_factory=list)
    directions: set[str] = field(default_factory=set)

    def add(self, anchor: ModelLinkAnchor, direction: str | None = None) -> None:
        self.count += 1
        if direction:
            self.directions.add(direction)
        if len(self.anchors) < ANCHOR_SAMPLE_LIMIT:
            self.anchors.append(anchor)

    def score(self) -> int:
        return self.base_score + min(self.count * 2, 20)

    def direction(self) -> str | None:
        return _resolve_direction(self.directions)

    def to_model(self) -> ModelLinkCriterion:
        return ModelLinkCriterion(
            type=self.type,
            label=self.label,
            strength=self.strength,
            count=self.count,
            direction=self.direction(),
            anchors=self.anchors,
        )


@dataclass
class EdgeAccumulator:
    source: str
    target: str
    shared_genes: dict[str, SharedGene] = field(default_factory=dict)
    criteria: dict[str, CriterionAccumulator] = field(default_factory=dict)
    directions: set[str] = field(default_factory=set)

    def criterion(self, criterion_type: str) -> CriterionAccumulator:
        if criterion_type not in self.criteria:
            label, strength, base_score = CRITERION_DEFS[criterion_type]
            self.criteria[criterion_type] = CriterionAccumulator(
                type=criterion_type,
                label=label,
                strength=strength,
                base_score=base_score,
            )
        return self.criteria[criterion_type]

    def add_criterion(
        self,
        criterion_type: str,
        anchor: ModelLinkAnchor,
        direction: str | None = None,
    ) -> None:
        if direction:
            self.directions.add(direction)
        self.criterion(criterion_type).add(anchor, direction=direction)

    def score(self) -> int:
        return sum(criterion.score() for criterion in self.criteria.values())

    def direction(self) -> str:
        return _resolve_direction(self.directions) or "undirected"

    def to_model_edge(self) -> ModelEdge:
        criteria = sorted(
            (criterion.to_model() for criterion in self.criteria.values()),
            key=lambda item: CRITERION_DEFS[item.type][2],
            reverse=True,
        )
        shared_genes = sorted(self.shared_genes.values(), key=lambda item: item.gene_id)
        return ModelEdge(
            source=self.source,
            target=self.target,
            shared_genes=shared_genes,
            weight=len(shared_genes),
            score=self.score(),
            direction=self.direction(),
            criteria=criteria,
        )


def _resolve_direction(directions: set[str]) -> str | None:
    if not directions:
        return None
    if len(directions) > 1:
        return "bidirectional"
    return next(iter(directions))


def _model_pair(left: str, right: str) -> tuple[str, str]:
    return (left, right) if left <= right else (right, left)


def _direction_for_pair(
    source_model: str, target_model: str, edge_source: str, edge_target: str
) -> str:
    return (
        "source_to_target"
        if source_model == edge_source and target_model == edge_target
        else "target_to_source"
    )


def _anchor_for_pair(
    edge_source: str,
    left_ref: ActivityLinkRef,
    right_ref: ActivityLinkRef,
) -> ModelLinkAnchor:
    source_ref, target_ref = (
        (left_ref, right_ref)
        if left_ref.model_id == edge_source
        else (right_ref, left_ref)
    )
    return ModelLinkAnchor(
        source_activity_id=source_ref.activity_id,
        target_activity_id=target_ref.activity_id,
        gene_id=source_ref.gene_id or target_ref.gene_id,
        gene_label=source_ref.gene_label or target_ref.gene_label,
        molecular_function=source_ref.molecular_function
        or target_ref.molecular_function,
        biological_process=source_ref.biological_process
        or target_ref.biological_process,
        cellular_component=source_ref.cellular_component
        or target_ref.cellular_component,
        molecule_id=source_ref.molecule_id or target_ref.molecule_id,
        molecule_label=source_ref.molecule_label or target_ref.molecule_label,
        source_role=source_ref.role,
        target_role=target_ref.role,
    )


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
    _generated_change_metadata: dict[str, Any] | None = field(
        default=None, init=False, repr=False
    )
    _connection_cache: dict[
        tuple[tuple[str, ...], tuple[str, ...], int], ConnectedModels
    ] = field(
        default_factory=dict,
        init=False,
        repr=False,
    )

    def __post_init__(self) -> None:
        if self.change_log_dir is not None:
            self.change_log_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _summary_from_entry(entry: dict) -> ModelSummary | None:
        gocam_url = entry.get("gocam", "")
        if not gocam_url:
            return None

        model_id = gocam_url.replace("http://model.geneontology.org/", "").replace(
            "https://model.geneontology.org/", ""
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
        summaries = [
            summary
            for entry in entries
            if (summary := self._summary_from_entry(entry)) is not None
        ]
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

    def _invalidate_connection_cache(self) -> None:
        self._connection_cache.clear()

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
    def _current_evidence(
        activity: Activity, association_name: str
    ) -> list[EvidenceItem] | None:
        association = getattr(activity, association_name, None)
        return association.evidence if association else None

    @staticmethod
    def _apply_shared_evidence(
        activity: Activity, evidence: list[EvidenceItem]
    ) -> None:
        for association_name in EDITABLE_ACTIVITY_ASSOCIATIONS:
            association = getattr(activity, association_name, None)
            if association is not None:
                association.evidence = evidence

    def _serialize_evidence(
        self, model: Model, evidence: list[EvidenceItem] | None
    ) -> list[dict] | None:
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
    def _upsert_object_label(
        model: Model, term_id: str | None, label: str | None
    ) -> None:
        if not term_id or not label or label == term_id:
            return
        if model.objects is None:
            model.objects = []
        for obj in model.objects:
            if obj.id == term_id:
                obj.label = label
                return
        model.objects.append(Object(id=term_id, label=label))

    def _term_snapshot(
        self, model: Model, term_id: str | None, label: str | None = None
    ) -> dict[str, str | None]:
        resolved_label = label or self._resolve_object_label(model, term_id)
        return {
            "term": term_id,
            "label": resolved_label,
        }

    def _shared_evidence_snapshot(
        self, model: Model, activity: Activity
    ) -> list[dict] | None:
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
            return (
                f"Changed {field_label} on {short_id}: {before_label} -> {after_label}"
            )
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
        payload = [
            change.model_dump(exclude_none=True)
            for change in self.change_log.get(model_id, [])
        ]
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
            change
            for change in changes
            if not self._is_generated_change(change)
            and change.status == "reverted"
            and bool((change.metadata or {}).get("redo_available"))
        ]
        if not redoable:
            raise ValueError(
                f"No reverted changes available to redo for model {model_id}"
            )

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
                    term_key: inverse.get(term_key)
                    if inverse.get(term_key) is not None
                    else (before_term or ""),
                    label_key: inverse.get(label_key)
                    if inverse.get(label_key) is not None
                    else before_label,
                }
            )

        if change.operation_type == "replace_evidence":
            raw_evidence = inverse.get("evidence") if isinstance(inverse, dict) else []
            return ActivityUpdate(
                evidence=self._evidence_inputs_from_snapshot(
                    [] if raw_evidence is None else raw_evidence
                )
            )

        raise ValueError(
            f"Unsupported activity revert operation: {change.operation_type}"
        )

    def _build_forward_activity_update(self, change: ChangeRecord) -> ActivityUpdate:
        if (
            change.operation_type not in TERM_CHANGE_FIELDS
            and change.operation_type != "replace_evidence"
        ):
            raise ValueError(
                f"Unsupported activity redo operation: {change.operation_type}"
            )

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

        raw_evidence = (
            (change.after or {}).get("evidence")
            if isinstance(change.after, dict)
            else []
        )
        return ActivityUpdate(
            evidence=self._evidence_inputs_from_snapshot(
                [] if raw_evidence is None else raw_evidence
            )
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
            if (
                change.operation_type in TERM_CHANGE_FIELDS
                or change.operation_type == "replace_evidence"
            ):
                target_activity_id = change.target.get("activity_id")
                if not isinstance(target_activity_id, str):
                    raise ValueError(
                        f"Change {change.id} is missing a valid activity target"
                    )
                self.update_activity(
                    model_id,
                    target_activity_id,
                    self._build_revert_activity_update(change),
                )
            elif change.operation_type == "add_causal_edge":
                inverse = change.inverse or {}
                source_activity_id = inverse.get("source_activity_id")
                target_activity_id = inverse.get("target_activity_id")
                predicate = inverse.get("predicate")
                if not all(
                    isinstance(value, str)
                    for value in (source_activity_id, target_activity_id, predicate)
                ):
                    raise ValueError(f"Change {change.id} is missing edge inverse data")
                removed = self.delete_causal_edge(
                    model_id, source_activity_id, target_activity_id, predicate
                )
                if not removed:
                    raise ValueError(
                        f"Unable to revert change {change.id}; edge was not present"
                    )
            elif change.operation_type == "delete_causal_edge":
                inverse = change.inverse or {}
                source_activity_id = inverse.get("source_activity_id")
                target_activity_id = inverse.get("target_activity_id")
                predicate = inverse.get("predicate")
                if not all(
                    isinstance(value, str)
                    for value in (source_activity_id, target_activity_id, predicate)
                ):
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
                raise ValueError(
                    f"Unsupported revert operation for {change.operation_type}"
                )
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
            if (
                change.operation_type in TERM_CHANGE_FIELDS
                or change.operation_type == "replace_evidence"
            ):
                target_activity_id = change.target.get("activity_id")
                if not isinstance(target_activity_id, str):
                    raise ValueError(
                        f"Change {change.id} is missing a valid activity target"
                    )
                self.update_activity(
                    model_id,
                    target_activity_id,
                    self._build_forward_activity_update(change),
                )
            elif change.operation_type == "add_causal_edge":
                target = change.target or {}
                source_activity_id = target.get("source_activity_id")
                target_activity_id = target.get("target_activity_id")
                predicate = target.get("predicate")
                if not all(
                    isinstance(value, str)
                    for value in (source_activity_id, target_activity_id, predicate)
                ):
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
                if not all(
                    isinstance(value, str)
                    for value in (source_activity_id, target_activity_id, predicate)
                ):
                    raise ValueError(f"Change {change.id} is missing edge target data")
                removed = self.delete_causal_edge(
                    model_id, source_activity_id, target_activity_id, predicate
                )
                if not removed:
                    raise ValueError(
                        f"Unable to redo change {change.id}; edge was not present"
                    )
            else:
                raise ValueError(
                    f"Unsupported redo operation for {change.operation_type}"
                )
        finally:
            self._generated_change_metadata = previous_metadata

        new_changes = change_list[before_count:]
        if not new_changes:
            raise ValueError(f"Change {change.id} produced no forward operation")
        return new_changes[-1]

    def _mark_change_reverted(
        self, model_id: str, original: ChangeRecord, revert_change: ChangeRecord
    ) -> None:
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
            raise ValueError(
                f"Generated change {change_id} cannot be reverted directly"
            )
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

    def update_activity(
        self, model_id: str, activity_id: str, update: ActivityUpdate
    ) -> Activity:
        """Apply a partial update to an activity, then persist via adapter."""
        model = self.get_model(model_id)
        activity = self._find_activity(model, activity_id)
        before_terms = {
            "enabled_by": activity.enabled_by.term if activity.enabled_by else None,
            "molecular_function": activity.molecular_function.term
            if activity.molecular_function
            else None,
            "part_of": activity.part_of.term if activity.part_of else None,
            "occurs_in": activity.occurs_in.term if activity.occurs_in else None,
        }
        before_snapshots = {
            "enabled_by": self._term_snapshot(model, before_terms["enabled_by"]),
            "molecular_function": self._term_snapshot(
                model, before_terms["molecular_function"]
            ),
            "part_of": self._term_snapshot(model, before_terms["part_of"]),
            "occurs_in": self._term_snapshot(model, before_terms["occurs_in"]),
        }
        before_evidence = self._shared_evidence_snapshot(model, activity)
        evidence = (
            self._build_evidence(update.evidence)
            if update.evidence is not None
            else None
        )

        if update.enabled_by_term is not None:
            self._upsert_object_label(
                model, update.enabled_by_term, update.enabled_by_label
            )
            activity.enabled_by = (
                EnabledByGeneProductAssociation(
                    term=update.enabled_by_term,
                    evidence=evidence
                    if update.evidence is not None
                    else self._current_evidence(activity, "enabled_by"),
                )
                if update.enabled_by_term
                else None
            )
        if update.molecular_function_term is not None:
            self._upsert_object_label(
                model, update.molecular_function_term, update.molecular_function_label
            )
            activity.molecular_function = (
                MolecularFunctionAssociation(
                    term=update.molecular_function_term,
                    evidence=evidence
                    if update.evidence is not None
                    else self._current_evidence(activity, "molecular_function"),
                )
                if update.molecular_function_term
                else None
            )
        if update.biological_process_term is not None:
            self._upsert_object_label(
                model, update.biological_process_term, update.biological_process_label
            )
            activity.part_of = (
                BiologicalProcessAssociation(
                    term=update.biological_process_term,
                    evidence=evidence
                    if update.evidence is not None
                    else self._current_evidence(activity, "part_of"),
                )
                if update.biological_process_term
                else None
            )
        if update.occurs_in_term is not None:
            self._upsert_object_label(
                model, update.occurs_in_term, update.occurs_in_label
            )
            activity.occurs_in = (
                CellularAnatomicalEntityAssociation(
                    term=update.occurs_in_term,
                    evidence=evidence
                    if update.evidence is not None
                    else self._current_evidence(activity, "occurs_in"),
                )
                if update.occurs_in_term
                else None
            )
        if update.evidence is not None:
            for evidence_input in update.evidence:
                self._upsert_object_label(
                    model, evidence_input.term, evidence_input.term_label
                )
            self._apply_shared_evidence(activity, evidence)

        self.adapter.save(model)
        self._invalidate_connection_cache()

        if (
            update.enabled_by_term is not None
            and update.enabled_by_term != before_terms["enabled_by"]
        ):
            after_term = activity.enabled_by.term if activity.enabled_by else None
            after_snapshot = self._term_snapshot(
                model, after_term, update.enabled_by_label
            )
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
                    before_snapshots["enabled_by"]["label"]
                    or before_terms["enabled_by"],
                    after_snapshot["label"] or after_term,
                ),
            )
        if (
            update.molecular_function_term is not None
            and update.molecular_function_term != before_terms["molecular_function"]
        ):
            after_term = (
                activity.molecular_function.term
                if activity.molecular_function
                else None
            )
            after_snapshot = self._term_snapshot(
                model, after_term, update.molecular_function_label
            )
            self._record_change(
                model_id=model_id,
                operation_type="set_molecular_function",
                target={"activity_id": activity_id, "field": "molecular_function"},
                before=before_snapshots["molecular_function"],
                after=after_snapshot,
                inverse={
                    "molecular_function_term": before_terms["molecular_function"] or "",
                    "molecular_function_label": before_snapshots["molecular_function"][
                        "label"
                    ],
                },
                summary=self._activity_change_summary(
                    "molecular function",
                    activity_id,
                    before_snapshots["molecular_function"]["label"]
                    or before_terms["molecular_function"],
                    after_snapshot["label"] or after_term,
                ),
            )
        if (
            update.biological_process_term is not None
            and update.biological_process_term != before_terms["part_of"]
        ):
            after_term = activity.part_of.term if activity.part_of else None
            after_snapshot = self._term_snapshot(
                model, after_term, update.biological_process_label
            )
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
        if (
            update.occurs_in_term is not None
            and update.occurs_in_term != before_terms["occurs_in"]
        ):
            after_term = activity.occurs_in.term if activity.occurs_in else None
            after_snapshot = self._term_snapshot(
                model, after_term, update.occurs_in_label
            )
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
                    name
                    for name in EDITABLE_ACTIVITY_ASSOCIATIONS
                    if getattr(activity, name, None) is not None
                ]
                self._record_change(
                    model_id=model_id,
                    operation_type="replace_evidence",
                    target={"activity_id": activity_id, "fields": target_associations},
                    before={"evidence": before_evidence},
                    after={"evidence": after_evidence},
                    inverse={
                        "evidence": before_evidence
                        if before_evidence is not None
                        else []
                    },
                    summary=f"Replaced shared evidence on {activity_id.split('/')[-1]}",
                )
        return activity

    def add_causal_edge(
        self, model_id: str, edge: CausalEdgeCreate
    ) -> CausalAssociation:
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
        self._invalidate_connection_cache()
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
        self._invalidate_connection_cache()
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

    @staticmethod
    def _normalize_criteria(criteria: list[str] | None) -> set[str]:
        if not criteria:
            return set()
        normalized: set[str] = set()
        for item in criteria:
            normalized.update(part.strip() for part in item.split(",") if part.strip())
        return normalized

    @staticmethod
    def _activity_roles(model: Model) -> dict[str, str]:
        incoming: set[str] = set()
        outgoing: set[str] = set()
        activity_ids = {activity.id for activity in model.activities or []}

        for activity in model.activities or []:
            for association in activity.causal_associations or []:
                if association.downstream_activity in activity_ids:
                    outgoing.add(activity.id)
                    incoming.add(association.downstream_activity)

        roles: dict[str, str] = {}
        for activity_id in activity_ids:
            has_incoming = activity_id in incoming
            has_outgoing = activity_id in outgoing
            if has_incoming and has_outgoing:
                roles[activity_id] = "internal"
            elif has_outgoing:
                roles[activity_id] = "initial"
            elif has_incoming:
                roles[activity_id] = "terminal"
            else:
                roles[activity_id] = "isolated"
        return roles

    @staticmethod
    def _object_labels(model: Model) -> dict[str, str]:
        return {
            obj.id: obj.label for obj in model.objects or [] if obj.id and obj.label
        }

    @staticmethod
    def _molecule_terms(model: Model) -> dict[str, str]:
        return {
            molecule.id: molecule.term
            for molecule in model.molecules or []
            if molecule.id and molecule.term
        }

    @staticmethod
    def _resolve_molecule_term(
        raw_molecule_id: str | None, molecule_terms: dict[str, str]
    ) -> str | None:
        if not raw_molecule_id:
            return None
        if raw_molecule_id.startswith("CHEBI:"):
            return raw_molecule_id
        return molecule_terms.get(raw_molecule_id)

    def _edge_for_pair(
        self,
        edges: dict[tuple[str, str], EdgeAccumulator],
        left_model: str,
        right_model: str,
    ) -> EdgeAccumulator:
        source, target = _model_pair(left_model, right_model)
        key = (source, target)
        if key not in edges:
            edges[key] = EdgeAccumulator(source=source, target=target)
        return edges[key]

    def _add_shared_ref_criterion(
        self,
        edges: dict[tuple[str, str], EdgeAccumulator],
        refs: list[ActivityLinkRef],
        criterion_type: str,
        shared_gene: SharedGene | None = None,
    ) -> None:
        refs_by_model: dict[str, ActivityLinkRef] = {}
        for ref in refs:
            refs_by_model.setdefault(ref.model_id, ref)

        model_ids = sorted(refs_by_model)
        if len(model_ids) < 2:
            return

        for left_model, right_model in combinations(model_ids, 2):
            edge = self._edge_for_pair(edges, left_model, right_model)
            left_ref = refs_by_model[left_model]
            right_ref = refs_by_model[right_model]
            if shared_gene is not None:
                edge.shared_genes.setdefault(shared_gene.gene_id, shared_gene)
            edge.add_criterion(
                criterion_type,
                _anchor_for_pair(edge.source, left_ref, right_ref),
            )

    def _add_directional_ref_criterion(
        self,
        edges: dict[tuple[str, str], EdgeAccumulator],
        source_ref: ActivityLinkRef,
        target_ref: ActivityLinkRef,
        criterion_type: str,
    ) -> None:
        if source_ref.model_id == target_ref.model_id:
            return
        edge = self._edge_for_pair(edges, source_ref.model_id, target_ref.model_id)
        direction = _direction_for_pair(
            source_ref.model_id, target_ref.model_id, edge.source, edge.target
        )
        edge.add_criterion(
            criterion_type,
            _anchor_for_pair(edge.source, source_ref, target_ref),
            direction=direction,
        )

    def _build_model_link_edges(
        self,
        model_ids: list[str],
    ) -> tuple[dict[str, dict], dict[tuple[str, str], EdgeAccumulator]]:
        model_info: dict[str, dict] = {}
        gene_refs: dict[tuple[str | None, str], list[ActivityLinkRef]] = defaultdict(
            list
        )
        gene_mf_refs: dict[tuple[str | None, str, str], list[ActivityLinkRef]] = (
            defaultdict(list)
        )
        signature_refs: dict[
            tuple[str | None, str, str, str, str], list[ActivityLinkRef]
        ] = defaultdict(list)
        chemical_refs: dict[tuple[str | None, str], list[ActivityLinkRef]] = (
            defaultdict(list)
        )
        chemical_input_refs: dict[tuple[str | None, str], list[ActivityLinkRef]] = (
            defaultdict(list)
        )
        chemical_output_refs: dict[tuple[str | None, str], list[ActivityLinkRef]] = (
            defaultdict(list)
        )

        for model_id in model_ids:
            model = self.adapter.get(model_id)
            if not model:
                continue

            object_labels = self._object_labels(model)
            molecule_terms = self._molecule_terms(model)
            roles = self._activity_roles(model)
            taxon = model.taxon
            model_info[model_id] = {
                "title": model.title or model_id,
                "taxon": taxon,
                "taxon_label": object_labels.get(taxon) if taxon else None,
                "activity_count": len(model.activities or []),
            }

            for activity in model.activities or []:
                gene = activity.enabled_by.term if activity.enabled_by else None
                mf = (
                    activity.molecular_function.term
                    if activity.molecular_function
                    else None
                )
                bp = activity.part_of.term if activity.part_of else None
                cc = activity.occurs_in.term if activity.occurs_in else None
                ref = ActivityLinkRef(
                    model_id=model_id,
                    activity_id=activity.id,
                    gene_id=gene,
                    gene_label=object_labels.get(gene) if gene else None,
                    molecular_function=mf,
                    biological_process=bp,
                    cellular_component=cc,
                    role=roles.get(activity.id),
                )

                if gene:
                    gene_refs[(taxon, gene)].append(ref)
                    if mf:
                        gene_mf_refs[(taxon, gene, mf)].append(ref)
                    if mf and bp and cc:
                        signature_refs[(taxon, gene, mf, bp, cc)].append(ref)

                for association in activity.molecular_associations or []:
                    molecule = self._resolve_molecule_term(
                        association.molecule, molecule_terms
                    )
                    if (
                        not molecule
                        or not molecule.startswith("CHEBI:")
                        or molecule in CURRENCY_CHEBI_IDS
                    ):
                        continue

                    molecule_ref = ActivityLinkRef(
                        model_id=model_id,
                        activity_id=activity.id,
                        gene_id=gene,
                        gene_label=object_labels.get(gene) if gene else None,
                        molecular_function=mf,
                        biological_process=bp,
                        cellular_component=cc,
                        molecule_id=molecule,
                        molecule_label=object_labels.get(molecule),
                        role=roles.get(activity.id),
                    )
                    key = (taxon, molecule)
                    chemical_refs[key].append(molecule_ref)
                    if association.predicate in INPUT_MOLECULE_PREDICATES:
                        chemical_input_refs[key].append(molecule_ref)
                    if association.predicate in OUTPUT_MOLECULE_PREDICATES:
                        chemical_output_refs[key].append(molecule_ref)

        edges: dict[tuple[str, str], EdgeAccumulator] = {}

        for (_, gene), refs in gene_refs.items():
            model_ids_for_gene = sorted({ref.model_id for ref in refs})
            shared_gene = SharedGene(
                gene_id=gene,
                label=next((ref.gene_label for ref in refs if ref.gene_label), None),
                model_ids=model_ids_for_gene,
            )
            self._add_shared_ref_criterion(
                edges, refs, "shared_gene", shared_gene=shared_gene
            )

        for refs in gene_mf_refs.values():
            self._add_shared_ref_criterion(edges, refs, "gene_mf")

        for refs in signature_refs.values():
            self._add_shared_ref_criterion(edges, refs, "full_activity_signature")
            refs_by_model: dict[str, list[ActivityLinkRef]] = defaultdict(list)
            for ref in refs:
                refs_by_model[ref.model_id].append(ref)
            for left_model, right_model in combinations(sorted(refs_by_model), 2):
                left_initial = next(
                    (ref for ref in refs_by_model[left_model] if ref.role == "initial"),
                    None,
                )
                left_terminal = next(
                    (
                        ref
                        for ref in refs_by_model[left_model]
                        if ref.role == "terminal"
                    ),
                    None,
                )
                right_initial = next(
                    (
                        ref
                        for ref in refs_by_model[right_model]
                        if ref.role == "initial"
                    ),
                    None,
                )
                right_terminal = next(
                    (
                        ref
                        for ref in refs_by_model[right_model]
                        if ref.role == "terminal"
                    ),
                    None,
                )
                if left_terminal and right_initial:
                    self._add_directional_ref_criterion(
                        edges, left_terminal, right_initial, "terminal_to_initial"
                    )
                if right_terminal and left_initial:
                    self._add_directional_ref_criterion(
                        edges, right_terminal, left_initial, "terminal_to_initial"
                    )

        for refs in chemical_refs.values():
            self._add_shared_ref_criterion(edges, refs, "shared_chemical")

        for key, output_refs in chemical_output_refs.items():
            input_refs = chemical_input_refs.get(key)
            if not input_refs:
                continue
            outputs_by_model: dict[str, ActivityLinkRef] = {}
            inputs_by_model: dict[str, ActivityLinkRef] = {}
            for ref in output_refs:
                outputs_by_model.setdefault(ref.model_id, ref)
            for ref in input_refs:
                inputs_by_model.setdefault(ref.model_id, ref)
            for output_model, output_ref in outputs_by_model.items():
                for input_model, input_ref in inputs_by_model.items():
                    if output_model != input_model:
                        self._add_directional_ref_criterion(
                            edges, output_ref, input_ref, "chemical_flow"
                        )

        return model_info, edges

    def get_model_connections(self, model_id: str) -> ModelConnections:
        """Find same-species model links for a model."""
        connected = self.find_connected_models()

        links: list[ModelEdge] = []
        linked_models: dict[str, ModelSummary] = {}
        gene_other_models: dict[str, dict[str, ModelSummary]] = defaultdict(dict)
        gene_labels: dict[str, str | None] = {}

        for cluster in connected.species_clusters:
            for edge in cluster.edges:
                if model_id not in (edge.source, edge.target):
                    continue
                links.append(edge)
                other_id = edge.target if edge.source == model_id else edge.source
                other_node = next(
                    (node for node in cluster.models if node.id == other_id), None
                )
                if other_node is None:
                    continue
                summary = ModelSummary(
                    id=other_node.id,
                    title=other_node.title,
                    taxon=other_node.taxon,
                    activity_count=other_node.activity_count,
                )
                linked_models[other_id] = summary
                for gene in edge.shared_genes:
                    gene_labels.setdefault(gene.gene_id, gene.label)
                    gene_other_models[gene.gene_id][other_id] = summary

        connections = [
            GeneConnection(
                gene_id=gene,
                label=gene_labels.get(gene),
                other_models=sorted(models.values(), key=lambda item: item.title),
            )
            for gene, models in sorted(
                gene_other_models.items(), key=lambda item: len(item[1]), reverse=True
            )
        ]

        return ModelConnections(
            model_id=model_id,
            connections=connections,
            linked_models=sorted(linked_models.values(), key=lambda item: item.title),
            model_links=sorted(links, key=lambda item: item.score, reverse=True),
        )

    def find_connected_models(
        self,
        model_ids: list[str] | None = None,
        criteria: list[str] | None = None,
        min_score: int = 0,
    ) -> ConnectedModels:
        """Find same-species model links grouped by species."""
        if model_ids is None:
            model_ids = self.adapter.list_ids()

        requested_criteria = self._normalize_criteria(criteria)
        cache_key = (tuple(model_ids), tuple(sorted(requested_criteria)), min_score)
        if cache_key in self._connection_cache:
            return self._connection_cache[cache_key]

        model_info, edge_accumulators = self._build_model_link_edges(model_ids)

        species_models: dict[str | None, list[str]] = defaultdict(list)
        for mid, info in model_info.items():
            species_models[info["taxon"]].append(mid)

        edge_models = [edge.to_model_edge() for edge in edge_accumulators.values()]
        if requested_criteria:
            edge_models = [
                edge
                for edge in edge_models
                if any(
                    criterion.type in requested_criteria for criterion in edge.criteria
                )
            ]
        if min_score > 0:
            edge_models = [edge for edge in edge_models if edge.score >= min_score]

        edges_by_taxon: dict[str | None, list[ModelEdge]] = defaultdict(list)
        for edge in edge_models:
            taxon = model_info[edge.source]["taxon"]
            edges_by_taxon[taxon].append(edge)

        clusters: list[SpeciesCluster] = []
        total_connections = 0

        for taxon, mids in sorted(
            species_models.items(), key=lambda item: len(item[1]), reverse=True
        ):
            edges = sorted(
                edges_by_taxon.get(taxon, []),
                key=lambda edge: (edge.score, edge.weight),
                reverse=True,
            )
            connected_mids = {
                model_id for edge in edges for model_id in (edge.source, edge.target)
            }
            include_mids = connected_mids if edges else set(mids)
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

        connected = ConnectedModels(
            species_clusters=clusters,
            total_models=len(model_info),
            total_connections=total_connections,
        )
        self._connection_cache[cache_key] = connected
        return connected

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
