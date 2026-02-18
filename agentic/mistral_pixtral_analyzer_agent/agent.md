# Mistral_pixtral_analyzer Agent

## Description
This agent provides capabilities related to `comprehensive image analysis` by leveraging Pydantic-AI models and AWS Bedrock.

## Skills

The `Mistral_pixtral_analyzer Agent` exposes the following skills:

### `analyze_with_mistral_pixtral`
*   **Description:** Analyzes an image using Mistral Pixtral Large to extract product attributes, generate descriptions, and provide pricing/quality hints.
*   **Inputs:**
    ```json
    {
      "processed_image_buffer_b64": "str",
      "product_name": "str | null",
      "rekognition_hints": {
        "labels": ["str"] | null,
        "detectedBrand": "str | null",
        "detectedSize": "str | null",
        "category": "str | null",
        "colors": ["str"] | null
      }
    }
    ```
*   **Outputs:**
    ```json
    {
      "brand": "str | null",
      "size": "str | null",
      "material": "str | null",
      "condition": "new_with_tags" | "like_new" | "very_good" | "good" | "fair",
      "category": "str",
      "colors": ["str"],
      "keywords": ["str"],
      "approved": "bool",
      "moderationReason": "str | null",
      "short_en": "str",
      "long_en": "str",
      "stylingTip_en": "str | null",
      "short_is": "str",
      "long_is": "str",
      "stylingTip_is": "str | null",
      "aiConfidence": {
        "brand": "float | null",
        "size": "float | null",
        "material": "float | null",
        "condition": "float",
        "colors": "float",
        "category": "float",
        "overall": "float"
      },
      "pattern": "str | null",
      "style": ["str"] | null,
      "season": "spring" | "summer" | "fall" | "winter" | "all-season" | null,
      "occasion": ["str"] | null,
      "careInstructions": ["str"] | null,
      "pricingHints": {
        "rarity": "common" | "uncommon" | "rare" | "vintage",
        "craftsmanship": "poor" | "fair" | "good" | "excellent",
        "marketDemand": "low" | "medium" | "high",
        "estimatedAgeYears": "int | null",
        "brandTier": "premium" | "luxury" | "designer" | "mass-market" | "unknown"
      },
      "qualityHints": {
        "materialQuality": "poor" | "fair" | "good" | "excellent",
        "constructionQuality": "poor" | "fair" | "good" | "excellent",
        "authenticity": "questionable" | "likely" | "confirmed",
        "visibleDefects": ["str"],
        "wearPattern": "minimal" | "light" | "moderate" | "heavy"
      }
    }
    ```

## Usage Example

```python
from marvin.beta.applications import Agent

# Assuming the agent is properly registered and discoverable
# Replace with actual agent ID/name if different
agent = Agent(name="mistral_pixtral_analyzer") 

# Example of invoking a skill (adjust based on actual skill names and parameters)
# result = agent.run_skill("some_skill_name", param1="value1", param2="value2")
# print(result)
```

## Configuration
This agent typically requires AWS credentials configured for Bedrock access in `us-east-1`.

## Related Pydantic-AI Module
*   **Module:** `services/bg-remover/agentic/pydantic_ai/mistral_pixtral_analyzer.py`
*   **Class:** `MistralPixtralAnalyzer`
