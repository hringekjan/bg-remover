# Background_remover Agent

## Description
This agent provides capabilities related to `background removal on images` by leveraging Pydantic-AI models and AWS Bedrock.

## Skills

The `Background_remover Agent` exposes the following skills:

### `remove_background`
*   **Description:** Remove background from a base64 encoded image using Amazon Nova Canvas.
*   **Inputs:**
    ```json
    {
      "base64_image": "str",
      "options": {
        "quality": "standard" | "premium",
        "height": "int",
        "width": "int"
      }
    }
    ```
*   **Outputs:**
    ```json
    {
      "output_buffer_b64": "str",
      "processing_time_ms": "int",
      "metadata": {
        "width": "int",
        "height": "int",
        "format": "str"
      }
    }
    ```

## Usage Example

```python
from marvin.beta.applications import Agent

# Assuming the agent is properly registered and discoverable
# Replace with actual agent ID/name if different
agent = Agent(name="background_remover") 

# Example of invoking a skill (adjust based on actual skill names and parameters)
# result = agent.run_skill("some_skill_name", param1="value1", param2="value2")
# print(result)
```

## Configuration
This agent typically requires AWS credentials configured for Bedrock access in `eu-west-1`.

## Related Pydantic-AI Module
*   **Module:** `services/bg-remover/agentic/pydantic_ai/background_remover.py`
*   **Class:** `BedrockBackgroundRemover`
