"""CLI entry point for the GO-CAM Mega Editor."""

import os
from pathlib import Path
from typing import Annotated

import typer
import uvicorn

app = typer.Typer(help="GO-CAM Mega Editor")


@app.command()
def serve(
    host: str = "127.0.0.1",
    port: int = 8000,
    reload: bool = True,
    adapter: Annotated[
        str,
        typer.Option(help="Storage adapter: minerva, memory, file:/path, minerva:url"),
    ] = "minerva",
) -> None:
    """Start the development server."""
    os.environ["GOCAM_ADAPTER"] = adapter
    uvicorn.run("gocam_mega_editor.app:app", host=host, port=port, reload=reload)


@app.command()
def cache_models(
    output_dir: Annotated[Path, typer.Argument(help="Directory to cache models")] = Path("data/models"),
    limit: Annotated[int, typer.Option(help="Max models to fetch")] = 50,
) -> None:
    """Fetch models from the GO API and cache them as JSON files."""
    from gocam_mega_editor.adapters import InMemoryAdapter, MinervaAdapter

    output_dir.mkdir(parents=True, exist_ok=True)
    source = MinervaAdapter()
    target = InMemoryAdapter(storage_dir=output_dir)

    ids = source.list_ids()[:limit]
    typer.echo(f"Fetching {len(ids)} models to {output_dir}...")
    for i, model_id in enumerate(ids):
        model = source.get(model_id)
        if model:
            target.save(model)
        if (i + 1) % 10 == 0:
            typer.echo(f"  ...{i + 1}/{len(ids)}")
    typer.echo(f"Done. {len(ids)} models cached in {output_dir}")


if __name__ == "__main__":
    app()
