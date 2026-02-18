# Rekognition_analyzer Agent

## Description
This agent provides capabilities related to `image analysis using AWS Rekognition` by leveraging Pydantic-AI models and AWS Bedrock.

## Skills

The `Rekognition_analyzer Agent` exposes the following skills:

### `analyze_with_rekognition`
*   **Description:** Runs AWS Rekognition APIs (DetectLabels, DetectText, DetectModerationLabels) in parallel on an image.
*   **Inputs:**
    ```json
    {
      "image_buffer": "bytes | null",
      "bucket": "str | null",
      "key": "str | null"
    }
    ```
*   **Outputs:**
    ```json
    {
      "approved": "bool",
      "reason": "str | null",
      "labels": ["str"],
      "colors": ["str"],
      "category": "str",
      "brand": "str | null",
      "size": "str | null",
      "material": "str | null",
      "careInstructions": ["str"] | null,
      "moderationLabels": [
        {
          "name": "str",
          "confidence": "float"
        }
      ],
      "rawLabels": [{}],
      "rawText": [{}]
    }
    ```

## Usage Example

```python
from marvin.beta.applications import Agent

# Assuming the agent is properly registered and discoverable
# Replace with actual agent ID/name if different
agent = Agent(name="rekognition_analyzer") 

# Example of invoking a skill (adjust based on actual skill names and parameters)
# result = agent.run_skill("some_skill_name", param1="value1", param2="value2")
# print(result)
```

## Configuration
This agent typically requires AWS credentials configured for Bedrock access in `eu-west-1`.

## Related Pydantic-AI Module
*   **Module:** `services/bg-remover/agentic/pydantic_ai/rekognition_analyzer.py`
*   **Class:** `RekognitionAnalyzer`
