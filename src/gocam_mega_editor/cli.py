"""CLI entry point for the GO-CAM Mega Editor."""

import typer
import uvicorn

app = typer.Typer(help="GO-CAM Mega Editor")


@app.command()
def serve(
    host: str = "127.0.0.1",
    port: int = 8000,
    reload: bool = True,
) -> None:
    """Start the development server."""
    uvicorn.run("gocam_mega_editor.app:app", host=host, port=port, reload=reload)


if __name__ == "__main__":
    app()
