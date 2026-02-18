import base64
import json
import time
from typing import Literal, Optional

import boto3
from pydantic import BaseModel, Field, ValidationError

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
