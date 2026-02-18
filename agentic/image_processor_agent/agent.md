# Image_processor Agent

## Description
This agent provides capabilities related to `image processing (background removal, description generation)` by leveraging Pydantic-AI models and AWS Bedrock.

## Skills

The `Image_processor Agent` exposes the following skills:

### `process_image_from_url`
*   **Description:** Downloads an image from a URL and processes it, optionally removing the background and generating a product description.
*   **Inputs:**
    ```json
    {
      "image_url": "str",
      "options": {
        "remove_background": "bool",
        "generate_description": "bool",
        "quality": "standard" | "premium",
        "height": "int",
        "width": "int"
      },
      "product_name": "str | null"
    }
    ```
*   **Outputs:**
    ```json
    {
      "output_buffer_b64": "str | null",
      "metadata": {},
      "product_description": {
        "short": "str",
        "long": "str",
        "category": "str",
        "colors": ["str"],
        "condition": "str",
        "keywords": ["str"],
        "stylingTip": "str | null"
      },
      "bilingual_description": {
        "en": {
          "short": "str",
          "long": "str",
          "category": "str",
          "colors": ["str"],
          "condition": "str",
          "keywords": ["str"],
          "stylingTip": "str | null"
        },
        "is": {
          "short": "str",
          "long": "str",
          "category": "str",
          "colors": ["str"],
          "condition": "str",
          "keywords": ["str"],
          "stylingTip": "str | null"
        }
      },
      "background_removal_result": {
        "output_buffer_b64": "str",
        "processing_time_ms": "int",
        "metadata": {
          "width": "int",
          "height": "int",
          "format": "str"
        }
      }
    }
    ```

### `process_image_from_base64`
*   **Description:** Processes a base64 encoded image, optionally removing the background and generating a product description.
*   **Inputs:**
    ```json
    {
      "base64_image": "str",
      "content_type": "str",
      "options": {
        "remove_background": "bool",
        "generate_description": "bool",
        "quality": "standard" | "premium",
        "height": "int",
        "width": "int"
      },
      "product_name": "str | null"
    }
    ```
*   **Outputs:**
    ```json
    {
      "output_buffer_b64": "str | null",
      "metadata": {},
      "product_description": {
        "short": "str",
        "long": "str",
        "category": "str",
        "colors": ["str"],
        "condition": "str",
        "keywords": ["str"],
        "stylingTip": "str | null"
      },
      "bilingual_description": {
        "en": {
          "short": "str",
          "long": "str",
          "category": "str",
          "colors": ["str"],
          "condition": "str",
          "keywords": ["str"],
          "stylingTip": "str | null"
        },
        "is": {
          "short": "str",
          "long": "str",
          "category": "str",
          "colors": ["str"],
          "condition": "str",
          "keywords": ["str"],
          "stylingTip": "str | null"
        }
      },
      "background_removal_result": {
        "output_buffer_b64": "str",
        "processing_time_ms": "int",
        "metadata": {
          "width": "int",
          "height": "int",
          "format": "str"
        }
      }
    }
    ```

## Usage Example

```python
from marvin.beta.applications import Agent

# Assuming the agent is properly registered and discoverable
# Replace with actual agent ID/name if different
agent = Agent(name="image_processor") 

# Example of invoking a skill (adjust based on actual skill names and parameters)
# result = agent.run_skill("some_skill_name", param1="value1", param2="value2")
# print(result)
```

## Configuration
This agent typically requires AWS credentials configured for Bedrock access in `eu-west-1`.

## Related Pydantic-AI Module
*   **Module:** `services/bg-remover/agentic/pydantic_ai/image_processor.py`
*   **Class:** `BedrockImageProcessor`
