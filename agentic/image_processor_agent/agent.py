import inspect
import sys
from typing import List, Type

from marvin.beta.applications import Agent
from marvin.tools import Tool

from ..pydantic_ai.image_processor import BedrockImageProcessor

# Instantiate the Pydantic-AI class
bedrock_image_processor_instance = BedrockImageProcessor()

def create_marvin_tool(func) -> Tool:
    """
    Creates a Marvin Tool from a Pydantic-AI class method.
    """
    signature = inspect.signature(func)
    parameters = signature.parameters
    
    description = inspect.getdoc(func) or f"Tool for {func.__name__} functionality."

    return Tool(
        name=func.__name__,
        description=description,
        func=func,
    )

def generate_agent_tools(pydantic_ai_instance: object) -> List[Tool]:
    tools = []
    for name, method in inspect.getmembers(pydantic_ai_instance, inspect.ismethod):
        if not name.startswith('_') and name != '__init__':
            if hasattr(method, '__annotations__') and method.annotations:
                try:
                    tool = create_marvin_tool(method)
                    tools.append(tool)
                    print(f"  - Created tool: {tool.name}")
                except Exception as e:
                    print(f"  - Failed to create tool for method {name}: {e}")
            else:
                print(f"  - Skipping method {name} (no type hints or not suitable for tool generation).")
    return tools

class ImageProcessorAgent(Agent):
    """
    Agent for processing images, including background removal and description generation, orchestrating other Pydantic-AI agents.
    """
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.pydantic_ai_instance = BedrockImageProcessor()
        
        print(f"Generating tools for ImageProcessorAgent from BedrockImageProcessor...")
        self.tools = generate_agent_tools(self.pydantic_ai_instance)
        print(f"ImageProcessorAgent loaded with {len(self.tools)} tools.")

if __name__ == "__main__":
    print("This is a template for a Marvin Agent. It requires specific Pydantic-AI class injection.")
