"""
BG-Remover Agent Startup Script

Registers all bg-remover agents with the LocalSentinels agent registry API
on service cold-start or local dev startup.

Usage:
    # Synchronous (e.g. from a shell script or CI step)
    python -m agentic.startup

    # Async (e.g. from an async framework startup hook)
    import asyncio
    from agentic.startup import run_async
    asyncio.run(run_async())

Environment variables:
    LOCALSENTINELS_BASE_URL  – LocalSentinels API base URL (default: http://localhost:8080)
    SKIP_AGENT_REGISTRATION  – Set to "1" to skip registration (useful in Lambda cold-start)
"""

import asyncio
import logging
import os
import sys

logger = logging.getLogger(__name__)


def run() -> bool:
    """
    Synchronously register all bg-remover agents with LocalSentinels.

    Returns True if all agents registered successfully, False otherwise.
    Skips silently if SKIP_AGENT_REGISTRATION=1.
    """
    if os.getenv("SKIP_AGENT_REGISTRATION", "").strip() == "1":
        logger.info("SKIP_AGENT_REGISTRATION=1 — skipping agent registration")
        return True

    from agentic.agent_registry import register_bg_remover_agents

    results = register_bg_remover_agents()
    all_ok = all(results.values())
    return all_ok


async def run_async() -> bool:
    """
    Async variant — for use in FastAPI lifespan events or other async startup hooks.

    Returns True if all agents registered successfully, False otherwise.
    Skips silently if SKIP_AGENT_REGISTRATION=1.
    """
    if os.getenv("SKIP_AGENT_REGISTRATION", "").strip() == "1":
        logger.info("SKIP_AGENT_REGISTRATION=1 — skipping agent registration")
        return True

    from agentic.agent_registry import register_bg_remover_agents_async

    results = await register_bg_remover_agents_async()
    all_ok = all(results.values())
    return all_ok


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    success = run()
    sys.exit(0 if success else 1)
