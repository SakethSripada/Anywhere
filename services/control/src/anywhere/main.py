"""Entrypoints: `anywhere serve` and `anywhere identity` (mint a worker identity)."""

from __future__ import annotations

import argparse
import asyncio
import logging

import structlog
import uvicorn

from .config import get_settings
from .stdb import SpacetimeClient


def _configure_logging(level: str) -> None:
    logging.basicConfig(level=level, format="%(message)s")
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.dev.ConsoleRenderer() if level == "DEBUG" else structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelName(level)),
    )


async def _mint_identity() -> None:
    s = get_settings()
    client = SpacetimeClient(s.spacetime_host, s.spacetime_database)
    identity, token = await client.create_identity()
    await client.close()
    print(f"identity: 0x{identity}")
    print(f"token:    {token}")
    print()
    print("Allowlist it as a worker (run as the database owner):")
    print(
        f"  spacetime sql {s.spacetime_database} \"INSERT INTO worker (identity, label) VALUES (0x{identity}, 'control')\""
    )
    print("Then set SPACETIME_WORKER_TOKEN to the token above.")


def cli() -> None:
    parser = argparse.ArgumentParser(prog="anywhere")
    sub = parser.add_subparsers(dest="cmd", required=True)
    serve = sub.add_parser("serve", help="Run the control plane")
    serve.add_argument("--host", default="0.0.0.0")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--reload", action="store_true")
    sub.add_parser("identity", help="Mint a SpacetimeDB identity for a worker service")
    args = parser.parse_args()

    settings = get_settings()
    _configure_logging(settings.log_level)
    if args.cmd == "identity":
        asyncio.run(_mint_identity())
        return
    uvicorn.run(
        "anywhere.api:create_app",
        factory=True,
        host=args.host,
        port=args.port,
        reload=args.reload,
        proxy_headers=True,
        ws_max_size=16 * 1024 * 1024,
    )


if __name__ == "__main__":
    cli()
