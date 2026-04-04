"""CLI entry point for the GO-CAM Mega Editor."""

import os
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


if __name__ == "__main__":
    app()
