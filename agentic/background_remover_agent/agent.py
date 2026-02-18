import inspect
import sys
from typing import List, Type

from marvin.beta.applications import Agent
from marvin.tools import Tool

# Assuming Pydantic-AI classes are in a relative path
# Adjust this import based on the actual location of your Pydantic-AI modules
from ..pydantic_ai.background_remover import BedrockBackgroundRemover

# Instantiate the Pydantic-AI class
bedrock_background_remover_instance = BedrockBackgroundRemover()

# Function to dynamically create a Marvin Tool from a Pydantic-AI method
def create_marvin_tool(func) -> Tool:
    """
    Creates a Marvin Tool from a Pydantic-AI class method.
    """
    signature = inspect.signature(func)
    parameters = signature.parameters
    
    # Extract docstring for description
    description = inspect.getdoc(func) or f"Tool for {func.__name__} functionality."

    # Marvin Tools expect a Callable, Pydantic-AI methods are Callables.
    # The Pydantic model for input will be derived by Marvin from the type hints.
    return Tool(
        name=func.__name__,
        description=description,
        func=func,
    )

# Dynamically generate tools from the Pydantic-AI class instance
# This assumes that all public methods of the Pydantic-AI class
# that have type hints should become Marvin Tools.
def generate_agent_tools(pydantic_ai_instance: object) -> List[Tool]:
    tools = []
    for name, method in inspect.getmembers(pydantic_ai_instance, inspect.ismethod):
        # Exclude private methods and magic methods
        if not name.startswith('_') and name != '__init__':
            # Check if method has type hints (implies it's designed for structured input/output)
            if hasattr(method, '__annotations__') and method.annotations: # Use .annotations for Python 3.9+
                try:
                    tool = create_marvin_tool(method)
                    tools.append(tool)
                    print(f"  - Created tool: {tool.name}")
                except Exception as e:
                    print(f"  - Failed to create tool for method {name}: {e}")
            else:
                print(f"  - Skipping method {name} (no type hints or not suitable for tool generation).")
    return tools

# Main Agent definition
class BackgroundRemoverAgent(Agent):
    """
    Agent for performing background removal on images using AWS Bedrock's Nova Canvas.
    """
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        # Instantiate the Pydantic-AI class
        self.pydantic_ai_instance = BedrockBackgroundRemover()
        
        # Generate tools from the Pydantic-AI instance
        print(f"Generating tools for BackgroundRemoverAgent from BedrockBackgroundRemover...")
        self.tools = generate_agent_tools(self.pydantic_ai_instance)
        print(f"BackgroundRemoverAgent loaded with {len(self.tools)} tools.")

# For direct execution or testing
if __name__ == "__main__":
    print("This is a template for a Marvin Agent. It requires specific Pydantic-AI class injection.")
    print("To use, replace placeholders with actual class imports and instantiation.")
    print("Example usage (after filling placeholders):")
    # from your_module import YourPydanticAIClass
    # your_ai_instance = YourPydanticAIClass()
    # my_agent = YourMarvinAgent(pydantic_ai_instance=your_ai_instance, description="My custom agent")
    # print(my_agent.tools)
