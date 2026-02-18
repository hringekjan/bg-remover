# services/bg-remover/agentic/agent_registry.py

"""
Central registry for all Marvin agents and Pydantic-AI skills within the bg-remover service.

This module is intended to be scanned by the LocalSentinels framework for agent discovery.
Each sub-folder represents a distinct agent with its own agent.py entrypoint and skills.
"""

from marvin.beta.applications import Agent
from marvin.tools import Tool
from typing import List, Type

# Import individual agents
from .background_remover_agent.agent import BackgroundRemoverAgent
from .image_analysis_agent.agent import ImageAnalysisAgent
from .image_processor_agent.agent import ImageProcessorAgent
from .mistral_pixtral_analyzer_agent.agent import MistralPixtralAnalyzerAgent
from .rekognition_analyzer_agent.agent import RekognitionAnalyzerAgent
from .ai_extractor_agent.agent import AIExtractorAgent
from .product_grouper_agent.agent import ProductGrouperAgent


# List of all agents to be registered
# LocalSentinels or another discovery mechanism would import this list
# or dynamically scan the directory structure.
ALL_BG_REMOVER_AGENTS: List[Type[Agent]] = [
    BackgroundRemoverAgent,
    ImageAnalysisAgent,
    ImageProcessorAgent,
    MistralPixtralAnalyzerAgent,
    RekognitionAnalyzerAgent,
    AIExtractorAgent,
    ProductGrouperAgent,
]

def register_bg_remover_agents():
    """
    Function to explicitly register agents with LocalSentinels if an API is available.
    (Placeholder implementation)
    """
    print("Attempting to register BG-Remover agents with LocalSentinels...")
    for agent_class in ALL_BG_REMOVER_AGENTS:
        # In a real scenario, this would involve calling a LocalSentinels SDK method
        # or sending a registration request.
        print(f"  - Registering agent: {agent_class.__name__}")
        # LocalSentinels.register_agent(agent_class) # Example API call
    print("BG-Remover agent registration process initiated.")

if __name__ == "__main__":
    print("BG-Remover Agent Registry module.")
    print(f"Total agents listed: {len(ALL_BG_REMOVER_AGENTS)}")
    # register_bg_remover_agents() # This would be called by the LocalSentinels orchestrator
