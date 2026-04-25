# services/bg-remover/agentic/agent_registry.py

"""
Central registry for all Marvin agents and Pydantic-AI skills within the bg-remover service.

This module is intended to be scanned by the LocalSentinels framework for agent discovery.
Each sub-folder represents a distinct agent with its own agent.py entrypoint and skills.

Agent registration POSTs to the LocalSentinels agent API:
  POST {LOCALSENTINELS_BASE_URL}/api/agents/
  Body: {"name": str, "type": "pydantic-ai", "provider": "bedrock", "config": {...}}

Configure via environment variables:
  LOCALSENTINELS_BASE_URL  – defaults to http://localhost:8080
"""

import asyncio
import json
import logging
import os
import urllib.error
import urllib.request
from typing import List, Type

from marvin.beta.applications import Agent
from marvin.tools import Tool

# Import individual agents
from .background_remover_agent.agent import BackgroundRemoverAgent
from .image_analysis_agent.agent import ImageAnalysisAgent
from .image_processor_agent.agent import ImageProcessorAgent
from .mistral_pixtral_analyzer_agent.agent import MistralPixtralAnalyzerAgent
from .rekognition_analyzer_agent.agent import RekognitionAnalyzerAgent
from .ai_extractor_agent.agent import AIExtractorAgent
from .product_grouper_agent.agent import ProductGrouperAgent

logger = logging.getLogger(__name__)

# List of all agents to be registered.
ALL_BG_REMOVER_AGENTS: List[Type[Agent]] = [
    BackgroundRemoverAgent,
    ImageAnalysisAgent,
    ImageProcessorAgent,
    MistralPixtralAnalyzerAgent,
    RekognitionAnalyzerAgent,
    AIExtractorAgent,
    ProductGrouperAgent,
]

# Agent metadata for registration — maps class name → API payload fields.
_AGENT_METADATA: dict[str, dict] = {
    "BackgroundRemoverAgent": {
        "name": "bg-remover-background",
        "type": "pydantic-ai",
        "provider": "bedrock",
        "config": {"service": "bg-remover", "model": "amazon.nova-canvas-v1:0"},
    },
    "ImageAnalysisAgent": {
        "name": "bg-remover-image-analysis",
        "type": "pydantic-ai",
        "provider": "bedrock",
        "config": {"service": "bg-remover", "model": "us.mistral.pixtral-large-2502-v1:0"},
    },
    "ImageProcessorAgent": {
        "name": "bg-remover-image-processor",
        "type": "pydantic-ai",
        "provider": "bedrock",
        "config": {"service": "bg-remover", "orchestrator": True},
    },
    "MistralPixtralAnalyzerAgent": {
        "name": "bg-remover-pixtral",
        "type": "pydantic-ai",
        "provider": "bedrock",
        "config": {"service": "bg-remover", "model": "us.mistral.pixtral-large-2502-v1:0"},
    },
    "RekognitionAnalyzerAgent": {
        "name": "bg-remover-rekognition",
        "type": "pydantic-ai",
        "provider": "bedrock",
        "config": {"service": "bg-remover", "aws_service": "rekognition"},
    },
    "AIExtractorAgent": {
        "name": "bg-remover-ai-extractor",
        "type": "pydantic-ai",
        "provider": "bedrock",
        "config": {"service": "bg-remover"},
    },
    "ProductGrouperAgent": {
        "name": "bg-remover-product-grouper",
        "type": "pydantic-ai",
        "provider": "bedrock",
        "config": {"service": "bg-remover", "model": "amazon.titan-embed-image-v1"},
    },
}


def _post_agent(base_url: str, payload: dict) -> bool:
    """POST a single agent registration to LocalSentinels. Returns True on success."""
    url = f"{base_url.rstrip('/')}/api/agents/"
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            logger.info(
                "Registered agent '%s' (HTTP %s)", payload["name"], resp.status
            )
            return True
    except urllib.error.HTTPError as exc:
        if exc.code == 409:
            # Already registered — treat as success
            logger.debug("Agent '%s' already registered (409)", payload["name"])
            return True
        logger.warning(
            "Failed to register agent '%s': HTTP %s %s",
            payload["name"], exc.code, exc.reason,
        )
        return False
    except urllib.error.URLError as exc:
        logger.warning(
            "Could not reach LocalSentinels at %s to register '%s': %s",
            base_url, payload["name"], exc,
        )
        return False


def register_bg_remover_agents() -> dict[str, bool]:
    """
    Register all bg-remover agents with the LocalSentinels agent registry API.

    POSTs each agent to POST /api/agents/ on LOCALSENTINELS_BASE_URL
    (default: http://localhost:8080).  Failures are logged but do not raise —
    the service starts regardless of registration status.

    Returns:
        dict mapping agent name → registration success (bool)
    """
    base_url = os.getenv("LOCALSENTINELS_BASE_URL", "http://localhost:8080")
    logger.info("Registering %d bg-remover agents with %s", len(ALL_BG_REMOVER_AGENTS), base_url)

    results: dict[str, bool] = {}
    for agent_class in ALL_BG_REMOVER_AGENTS:
        class_name = agent_class.__name__
        payload = _AGENT_METADATA.get(class_name)
        if not payload:
            logger.warning("No metadata for %s — skipping registration", class_name)
            results[class_name] = False
            continue
        results[payload["name"]] = _post_agent(base_url, payload)

    succeeded = sum(1 for v in results.values() if v)
    logger.info(
        "BG-Remover agent registration complete: %d/%d succeeded",
        succeeded, len(results),
    )
    return results


async def register_bg_remover_agents_async() -> dict[str, bool]:
    """
    Async variant of register_bg_remover_agents() for use in FastAPI lifespan
    or other async startup hooks.

    Runs the blocking HTTP registration in a thread pool to avoid blocking the
    event loop.
    """
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, register_bg_remover_agents)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    print(f"BG-Remover Agent Registry — {len(ALL_BG_REMOVER_AGENTS)} agents")
    results = register_bg_remover_agents()
    for name, ok in results.items():
        status = "✓" if ok else "✗"
        print(f"  {status} {name}")
