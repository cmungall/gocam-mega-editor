"""Storage adapters for GO-CAM model persistence.

Defines a Protocol for model storage and provides concrete implementations:

- MinervaAdapter: reads from GO API, writes to in-memory cache (Minerva dev server planned)
- InMemoryAdapter: dict-backed with optional JSON file persistence
- OverlayAdapter: reads from a base adapter, writes to a local overlay adapter
- (future) PostgresAdapter
"""

import json
import logging
from pathlib import Path
from typing import Protocol, runtime_checkable

from gocam.datamodel import Model
from gocam.translation.minerva_wrapper import MinervaWrapper

logger = logging.getLogger(__name__)


@runtime_checkable
class ModelAdapter(Protocol):
    """Protocol for GO-CAM model storage backends.

    Implementations handle reading, writing, and listing models.
    The protocol is intentionally minimal — complex query patterns
    belong in the service layer, not the adapter.
    """

    def list_ids(self) -> list[str]:
        """Return all available model IDs."""
        ...

    def list_summaries(self, limit: int = 100, offset: int = 0) -> list[dict]:
        """Return lightweight model summaries for the listing page."""
        ...

    def get(self, model_id: str) -> Model | None:
        """Fetch a model by ID. Returns None if not found."""
        ...

    def save(self, model: Model) -> None:
        """Persist a model (create or update)."""
        ...

    def delete(self, model_id: str) -> bool:
        """Delete a model by ID. Returns True if it existed."""
        ...


class MinervaAdapter:
    """Reads from the GO Minerva API, caches and mutates in memory.

    This is the default adapter for bootstrapping. It fetches models
    from the live (or dev) Minerva server and caches them locally.
    Writes go to the in-memory cache only — Minerva write-back
    via the Barista API is planned for a future iteration.

    >>> adapter = MinervaAdapter()
    >>> isinstance(adapter, ModelAdapter)
    True
    """

    def __init__(
        self,
        endpoint_base: str = "https://api.geneontology.org/api/go-cam/",
        index_url: str = "https://go-public.s3.amazonaws.com/files/gocam-models.json",
        storage_dir: Path | str | None = None,
    ):
        self._wrapper = MinervaWrapper(
            gocam_endpoint_base=endpoint_base,
            gocam_index_url=index_url,
        )
        self._cache: dict[str, Model] = {}
        self._index: list[dict] | None = None
        self._storage_dir = Path(storage_dir) if storage_dir else None
        if self._storage_dir:
            self._storage_dir.mkdir(parents=True, exist_ok=True)

    def _model_path(self, model_id: str) -> Path:
        safe_id = model_id.replace("/", "_").replace(":", "_")
        return self._storage_dir / f"{safe_id}.json"

    def _fetch_index(self) -> list[dict]:
        if self._index is None:
            response = self._wrapper.session.get(self._wrapper.gocam_index_url)
            response.raise_for_status()
            self._index = response.json()
        return self._index

    def list_ids(self) -> list[str]:
        return [
            entry["gocam"].replace("http://model.geneontology.org/", "")
            for entry in self._fetch_index()
        ]

    def list_summaries(self, limit: int = 100, offset: int = 0) -> list[dict]:
        index = self._fetch_index()
        return index[offset : offset + limit]

    def get(self, model_id: str) -> Model | None:
        if model_id not in self._cache:
            if self._storage_dir:
                path = self._model_path(model_id)
                if path.exists():
                    self._cache[model_id] = Model(**json.loads(path.read_text()))
                    return self._cache.get(model_id)
            self._cache[model_id] = self._wrapper.fetch_model(model_id)
        return self._cache.get(model_id)

    def save(self, model: Model) -> None:
        # Strip prefix for cache key
        model_id = model.id.replace("gomodel:", "")
        self._cache[model_id] = model
        if self._storage_dir:
            path = self._model_path(model_id)
            path.write_text(model.model_dump_json(indent=2, exclude_none=True))
            logger.info("Model %s persisted to %s", model_id, path)
        logger.info("Model %s saved to in-memory cache (Minerva write-back not yet implemented)", model_id)

    def delete(self, model_id: str) -> bool:
        existed = self._cache.pop(model_id, None) is not None
        if self._storage_dir:
            path = self._model_path(model_id)
            file_existed = path.exists()
            path.unlink(missing_ok=True)
            existed = existed or file_existed
        return existed


class InMemoryAdapter:
    """Dict-backed adapter with optional JSON file persistence.

    Models live in a dict. If `storage_dir` is provided, models are
    also written to/read from JSON files on disk for durability across
    server restarts.

    >>> adapter = InMemoryAdapter()
    >>> isinstance(adapter, ModelAdapter)
    True
    """

    def __init__(self, storage_dir: Path | str | None = None):
        self._models: dict[str, Model] = {}
        self._storage_dir = Path(storage_dir) if storage_dir else None
        if self._storage_dir:
            self._storage_dir.mkdir(parents=True, exist_ok=True)
            self._load_from_disk()

    def _model_path(self, model_id: str) -> Path:
        safe_id = model_id.replace("/", "_").replace(":", "_")
        return self._storage_dir / f"{safe_id}.json"

    def _load_from_disk(self) -> None:
        for path in self._storage_dir.glob("*.json"):
            data = json.loads(path.read_text())
            model = Model(**data)
            key = model.id.replace("gomodel:", "")
            self._models[key] = model
        logger.info("Loaded %d models from %s", len(self._models), self._storage_dir)

    def list_ids(self) -> list[str]:
        return list(self._models.keys())

    def list_summaries(self, limit: int = 100, offset: int = 0) -> list[dict]:
        ids = self.list_ids()[offset : offset + limit]
        summaries = []
        for model_id in ids:
            model = self._models[model_id]
            summaries.append({
                "gocam": f"http://model.geneontology.org/{model_id}",
                "title": model.title,
                "taxon": model.taxon,
                "state": model.status,
                "date": model.date_modified,
                "names": [],
                "groupnames": [],
                "activity_count": len(model.activities or []),
            })
        return summaries

    def get(self, model_id: str) -> Model | None:
        return self._models.get(model_id)

    def save(self, model: Model) -> None:
        model_id = model.id.replace("gomodel:", "")
        self._models[model_id] = model
        if self._storage_dir:
            path = self._model_path(model_id)
            path.write_text(model.model_dump_json(indent=2, exclude_none=True))
            logger.info("Model %s persisted to %s", model_id, path)

    def delete(self, model_id: str) -> bool:
        existed = self._models.pop(model_id, None) is not None
        if existed and self._storage_dir:
            path = self._model_path(model_id)
            path.unlink(missing_ok=True)
        return existed


class OverlayAdapter:
    """Read from a base adapter and persist local edits to an overlay adapter.

    This is useful for development against a local corpus: the base adapter
    serves the read-only seed data, while all edits are written into a separate
    overlay directory.
    """

    def __init__(self, base: ModelAdapter, overlay: InMemoryAdapter):
        self.base = base
        self.overlay = overlay

    @staticmethod
    def _summary_from_model(model_id: str, model: Model) -> dict:
        return {
            "gocam": f"http://model.geneontology.org/{model_id}",
            "title": model.title,
            "taxon": model.taxon,
            "state": model.status,
            "date": model.date_modified,
            "names": [],
            "groupnames": [],
            "activity_count": len(model.activities or []),
        }

    def list_ids(self) -> list[str]:
        seen: set[str] = set()
        ids: list[str] = []
        for model_id in self.base.list_ids():
            if model_id not in seen:
                ids.append(model_id)
                seen.add(model_id)
        for model_id in self.overlay.list_ids():
            if model_id not in seen:
                ids.append(model_id)
                seen.add(model_id)
        return ids

    def list_summaries(self, limit: int = 100, offset: int = 0) -> list[dict]:
        ids = self.list_ids()[offset : offset + limit]
        summaries: list[dict] = []
        for model_id in ids:
            model = self.get(model_id)
            if model is None:
                continue
            summaries.append(self._summary_from_model(model_id, model))
        return summaries

    def get(self, model_id: str) -> Model | None:
        return self.overlay.get(model_id) or self.base.get(model_id)

    def save(self, model: Model) -> None:
        self.overlay.save(model)

    def delete(self, model_id: str) -> bool:
        return self.overlay.delete(model_id)
