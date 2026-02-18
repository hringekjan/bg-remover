# Image_analysis Agent

## Description
This agent provides capabilities related to `image analysis and translation` by leveraging Pydantic-AI models and AWS Bedrock.

## Skills

The `Image_analysis Agent` exposes the following skills:

### `analyze_image_for_description`
*   **Description:** Analyzes an image to generate a structured product description.
*   **Inputs:**
    ```json
    {
      "image_buffer_b64": "str",
      "product_name": "str | null",
      "metadata": {
        "complexityScore": "float | null",
        "megapixels": "float | null",
        "fileSizeMB": "float | null"
      }
    }
    ```
*   **Outputs:**
    ```json
    {
      "short": "str",
      "long": "str",
      "category": "str",
      "colors": ["str"],
      "condition": "new_with_tags" | "like_new" | "very_good" | "good" | "fair",
      "keywords": ["str"],
      "stylingTip": "str | null"
    }
    ```

### `translate_to_icelandic`
*   **Description:** Translates a ProductDescription object into Icelandic using an LLM.
*   **Inputs:**
    ```json
    {
      "description": {
        "short": "str",
        "long": "str",
        "category": "str",
        "colors": ["str"],
        "condition": "new_with_tags" | "like_new" | "very_good" | "good" | "fair",
        "keywords": ["str"],
        "stylingTip": "str | null"
      }
    }
    ```
*   **Outputs:**
    ```json
    {
      "short": "str",
      "long": "str",
      "category": "str",
      "colors": ["str"],
      "condition": "new_with_tags" | "like_new" | "very_good" | "good" | "fair",
      "keywords": ["str"],
      "stylingTip": "str | null"
    }
    ```

### `generate_bilingual_description`
*   **Description:** Generates a bilingual (English and Icelandic) product description from an image.
*   **Inputs:**
    ```json
    {
      "image_buffer_b64": "str",
      "product_name": "str | null",
      "metadata": {
        "complexityScore": "float | null",
        "megapixels": "float | null",
        "fileSizeMB": "float | null"
      }
    }
    ```
*   **Outputs:**
    ```json
    {
      "en": {
        "short": "str",
        "long": "str",
        "category": "str",
        "colors": ["str"],
        "condition": "new_with_tags" | "like_new" | "very_good" | "good" | "fair",
        "keywords": ["str"],
        "stylingTip": "str | null"
      },
      "is": {
        "short": "str",
        "long": "str",
        "category": "str",
        "colors": ["str"],
        "condition": "new_with_tags" | "like_new" | "very_good" | "good" | "fair",
        "keywords": ["str"],
        "stylingTip": "str | null"
      }
    }
    ```

## Usage Example

```python
from marvin.beta.applications import Agent

# Assuming the agent is properly registered and discoverable
# Replace with actual agent ID/name if different
agent = Agent(name="image_analysis") 

# Example of invoking a skill (adjust based on actual skill names and parameters)
# result = agent.run_skill("some_skill_name", param1="value1", param2="value2")
# print(result)
```

## Configuration
This agent typically requires AWS credentials configured for Bedrock access in `eu-west-1`.

## Related Pydantic-AI Module
*   **Module:** `services/bg-remover/agentic/pydantic_ai/image_analysis.py`
*   **Class:** `BedrockImageAnalyzer`
