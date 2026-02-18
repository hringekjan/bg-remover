# Ai_extractor Agent

## Description
This agent provides capabilities related to `structured product attribute extraction` by leveraging Pydantic-AI models and AWS Bedrock.

## Skills

The `Ai_extractor Agent` exposes the following skills:

### `extract_attributes`
*   **Description:** Extracts structured product attributes from AI-generated descriptions or uses regex-based extraction as a fallback.
*   **Inputs:**
    ```json
    {
      "product_name": "str",
      "bilingual_description": {
        "short": "str",
        "long": "str",
        "category": "str",
        "colors": ["str"],
        "condition": "new_with_tags" | "like_new" | "very_good" | "good" | "fair",
        "keywords": ["str"],
        "stylingTip": "str | null"
      },
      "mistral_result": {
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
      } | null
    }
    ```
*   **Outputs:**
    ```json
    {
      "brand": "str | null",
      "material": "str | null",
      "colors": ["str"],
      "pattern": "str | null",
      "style": ["str"],
      "sustainability": ["str"],
      "keywords": ["str"],
      "category": {
        "primary": "str",
        "secondary": "str",
        "tertiary": "str",
        "path": "str"
      },
      "careInstructions": ["str"],
      "conditionRating": "int | null",
      "aiConfidence": {
        "brand": "float | null",
        "material": "float | null",
        "colors": "float | null",
        "pattern": "float | null",
        "style": "float | null",
        "keywords": "float | null",
        "category": "float | null",
        "careInstructions": "float | null",
        "conditionRating": "float | null"
      },
      "translations": {
        "is": {
          "material": "str | null",
          "colors": ["str"] | null,
          "pattern": "str | null",
          "style": ["str"] | null,
          "careInstructions": ["str"] | null
        }
      }
    }
    ```

## Usage Example

```python
from marvin.beta.applications import Agent

# Assuming the agent is properly registered and discoverable
# Replace with actual agent ID/name if different
agent = Agent(name="ai_extractor") 

# Example of invoking a skill (adjust based on actual skill names and parameters)
# result = agent.run_skill("some_skill_name", param1="value1", param2="value2")
# print(result)
```

## Configuration
This agent typically requires AWS credentials configured for Bedrock access in `eu-west-1`.

## Related Pydantic-AI Module
*   **Module:** `services/bg-remover/agentic/pydantic_ai/ai_extractor.py`
*   **Class:** `AIAttributeExtractor`
