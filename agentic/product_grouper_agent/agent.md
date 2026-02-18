# Product_grouper Agent

## Description
This agent provides capabilities related to `image grouping and product identity` by leveraging Pydantic-AI models and AWS Bedrock.

## Skills

The `Product_grouper Agent` exposes the following skills:

### `batch_process_with_multi_signal`
*   **Description:** Batch processes images for grouping, including feature extraction, embedding generation, and multi-signal similarity clustering.
*   **Inputs:**
    ```json
    {
      "images": "[{ "id": "str", "buffer": "bytes", "metadata": {}, "width": "int", "height": "int" }]",
      "tenant": "str",
      "stage": "str",
      "include_existing_embeddings": "bool"
    }
    ```
*   **Outputs:**
    ```json
    {
      "groups": "[{...}]",
      "ungrouped": "["str"]",
      "processed": "int",
      "existingMatched": "int",
      "multiSignalEnabled": "bool"
    }
    ```

### `process_image_for_grouping`
*   **Description:** Processes a single image to generate its embedding, find similar images, and assign it to an existing or new product group.
*   **Inputs:**
    ```json
    {
      "image_id": "str",
      "image_buffer": "bytes",
      "tenant": "str",
      "metadata": {} | null
    }
    ```
*   **Outputs:**
    ```json
    {
      "embedding": "[float]",
      "similarImages": "[{...}]",
      "assignedGroup": "{...} | null",
      "isNewGroup": "bool"
    }
    ```

## Usage Example

```python
from marvin.beta.applications import Agent

# Assuming the agent is properly registered and discoverable
# Replace with actual agent ID/name if different
agent = Agent(name="product_grouper") 

# Example of invoking a skill (adjust based on actual skill names and parameters)
# result = agent.run_skill("some_skill_name", param1="value1", param2="value2")
# print(result)
```

## Configuration
This agent typically requires AWS credentials configured for Bedrock access in `eu-west-1`.

## Related Pydantic-AI Module
*   **Module:** `services/bg-remover/agentic/pydantic_ai/product_grouper.py`
*   **Class:** `ProductIdentityGrouper`
