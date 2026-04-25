import base64
import json
import time
from typing import Literal, Optional

import boto3
from pydantic import BaseModel, Field, ValidationError
from pydantic_ai import RunContext

try:
    from agentic.agents.pydantic.agents.base_hooked_agent import HookedAgent
    _HOOKED_AGENT_AVAILABLE = True
except ImportError:
    _HOOKED_AGENT_AVAILABLE = False
    HookedAgent = object  # fallback base so class definition doesn't fail

class RemoveBackgroundOptions(BaseModel):
    """Options for background removal."""
    quality: Literal["standard", "premium"] = Field("premium", description="Quality of the background removal.")
    height: int = Field(1024, description="Desired height of the output image.")
    width: int = Field(1024, description="Desired width of the output image.")

class RemoveBackgroundResult(BaseModel):
    """Result of background removal."""
    output_buffer_b64: str = Field(..., description="Base64 encoded output image buffer.")
    processing_time_ms: int = Field(..., description="Time taken for processing in milliseconds.")
    metadata: dict = Field(..., description="Metadata about the processed image (width, height, format).")

class BedrockBackgroundRemover:
    """
    Agent for removing background from images using Amazon Nova Canvas on AWS Bedrock.
    """
    def __init__(self, region_name: str = 'us-east-1'):
        self.bedrock_client = boto3.client('bedrock-runtime', region_name=region_name)

    def remove_background(
        self,
        base64_image: str = Field(..., description="Base64 encoded input image."),
        options: Optional[RemoveBackgroundOptions] = None
    ) -> RemoveBackgroundResult:
        """
        Remove background from a base64 encoded image using Amazon Nova Canvas.

        Args:
            base64_image: The base64 encoded string of the input image.
            options: Optional settings for quality, height, and width.

        Returns:
            A RemoveBackgroundResult object containing the output image buffer (base64 encoded),
            processing time, and metadata.
        """
        start_time = time.time() * 1000

        if options is None:
            options = RemoveBackgroundOptions()

        body = {
            "taskType": "BACKGROUND_REMOVAL",
            "backgroundRemovalParams": {
                "image": base64_image
            },
            "imageGenerationConfig": {
                "numberOfImages": 1,
                "quality": options.quality,
                "height": options.height,
                "width": options.width
            }
        }

        response = self.bedrock_client.invoke_model(
            modelId='amazon.nova-canvas-v1:0',
            contentType='application/json',
            accept='application/json',
            body=json.dumps(body)
        )

        result = json.loads(response['body'].read().decode('utf-8'))

        if not result.get('images') or len(result['images']) == 0:
            raise ValueError('Nova Canvas failed to return a processed image')

        output_buffer_b64 = result['images'][0]

        end_time = time.time() * 1000
        processing_time_ms = int(end_time - start_time)

        metadata = {
            "width": options.width,
            "height": options.height,
            "format": "png"  # Nova Canvas typically outputs PNG
        }

        return RemoveBackgroundResult(
            output_buffer_b64=output_buffer_b64,
            processing_time_ms=processing_time_ms,
            metadata=metadata
        )


# ============================================================================
# Companion pydantic-ai Agent (HookedAgent pattern)
# ============================================================================


class BedrockBackgroundRemoverAgent(HookedAgent):
    """
    Pydantic-AI companion agent for BedrockBackgroundRemover.

    Wraps the BedrockBackgroundRemover service class as a pydantic-ai Agent
    with full LocalSentinels observability via HookedAgent hooks.

    Usage:
        agent = BedrockBackgroundRemoverAgent()
        result = await agent.run("Remove background from this image: <base64>")
    """

    agent_name: str = "BedrockBackgroundRemoverAgent"

    def __init__(
        self,
        model: str = "bedrock:amazon.nova-canvas-v1:0",
        region_name: str = "us-east-1",
        workflow_id: Optional[str] = None,
        session_id: Optional[str] = None,
        sentinels_url: str = "http://localhost:8080",
    ):
        self._service = BedrockBackgroundRemover(region_name=region_name)
        super().__init__(
            model=model,
            workflow_id=workflow_id,
            session_id=session_id,
            sentinels_url=sentinels_url,
        )
        self._register_tools()

    def _register_tools(self) -> None:
        """Register service methods as pydantic-ai tools."""
        service = self._service

        @self.tool
        async def remove_background(
            ctx: RunContext[None],
            base64_image: str,
            quality: str = "premium",
            height: int = 1024,
            width: int = 1024,
        ) -> dict:
            """
            Remove background from a base64-encoded image using Amazon Nova Canvas.

            Args:
                base64_image: Base64-encoded input image.
                quality: 'standard' or 'premium' (default: premium).
                height: Output image height in pixels (default: 1024).
                width: Output image width in pixels (default: 1024).

            Returns:
                Dict with output_buffer_b64, processing_time_ms, and metadata.
            """
            options = RemoveBackgroundOptions(
                quality=quality,  # type: ignore[arg-type]
                height=height,
                width=width,
            )
            result = service.remove_background(
                base64_image=base64_image, options=options
            )
            return result.model_dump()
