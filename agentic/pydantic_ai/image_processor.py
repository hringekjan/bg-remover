import base64
import json
import re
import time
from typing import Literal, Optional, List, Dict, Any, get_args

import boto3
import requests
from pydantic import BaseModel, Field, ValidationError

# Assuming these are available or will be created as Pydantic-AI agents
# from .image_analysis import BedrockImageAnalyzer, ProductDescription, BilingualProductDescription
# from .background_remover import BedrockBackgroundRemover, RemoveBackgroundResult


# Placeholder for types that would come from other Pydantic-AI agents
class ProductDescription(BaseModel):
    short: str
    long: str
    category: str
    colors: List[str]
    condition: str
    keywords: List[str]
    stylingTip: Optional[str] = None

class BilingualProductDescription(BaseModel):
    en: ProductDescription
    is_: ProductDescription = Field(..., alias="is")

class RemoveBackgroundResult(BaseModel):
    output_buffer_b64: str
    processing_time_ms: int
    metadata: Dict[str, Any]

class ImageProcessingOptions(BaseModel):
    """Options for image processing."""
    remove_background: bool = Field(False, description="Whether to remove the image background.")
    generate_description: bool = Field(True, description="Whether to generate a product description.")
    quality: Literal["standard", "premium"] = Field("premium", description="Quality for background removal.")
    height: int = Field(1024, description="Desired height for background removed image.")
    width: int = Field(1024, description="Desired width for background removed image.")
    # Add other processing options as needed from the TS original


class ProcessImageResult(BaseModel):
    """Result of image processing."""
    output_buffer_b64: Optional[str] = Field(None, description="Base64 encoded output image buffer (e.g., after background removal).")
    metadata: Dict[str, Any] = Field({}, description="Metadata about the processed image.")
    product_description: Optional[ProductDescription] = Field(None, description="Generated product description.")
    bilingual_description: Optional[BilingualProductDescription] = Field(None, description="Generated bilingual product description.")
    background_removal_result: Optional[RemoveBackgroundResult] = None


class BedrockImageProcessor:
    """
    Agent for processing images, including background removal and description generation,
    orchestrating other Pydantic-AI agents.
    """
    def __init__(self,
                 vision_region: str = 'us-east-1',
                 translation_region: str = 'eu-west-1',
                 background_removal_region: str = 'us-east-1'):
        # Instantiate other agents here
        # self.image_analyzer = BedrockImageAnalyzer(vision_region=vision_region, translation_region=translation_region)
        # self.background_remover = BedrockBackgroundRemover(region_name=background_removal_region)
        
        # For now, we'll use raw boto3 clients for demonstration until agents are fully integrated
        self._vision_client = boto3.client('bedrock-runtime', region_name=vision_region)
        self._translation_client = boto3.client('bedrock-runtime', region_name=translation_region)
        self._bg_remover_client = boto3.client('bedrock-runtime', region_name=background_removal_region)

        self.default_vision_model_id = 'us.mistral.pixtral-large-2502-v1:0'
        self.default_translation_model_id = 'openai.gpt-oss-120b-1:0'
        self.default_bg_removal_model_id = 'amazon.nova-canvas-v1:0'


    def _invoke_bg_removal_model(self, base64_image: str, options: ImageProcessingOptions) -> RemoveBackgroundResult:
        """Internal method to invoke background removal model."""
        start_time = time.time() * 1000
        body = {
            "taskType": "BACKGROUND_REMOVAL",
            "backgroundRemovalParams": { "image": base64_image },
            "imageGenerationConfig": {
                "numberOfImages": 1,
                "quality": options.quality,
                "height": options.height,
                "width": options.width
            }
        }
        response = self._bg_remover_client.invoke_model(
            modelId=self.default_bg_removal_model_id,
            contentType='application/json',
            accept='application/json',
            body=json.dumps(body)
        )
        result = json.loads(response['body'].read().decode('utf-8'))
        if not result.get('images') or len(result['images']) == 0:
            raise ValueError('Nova Canvas failed to return a processed image')
        
        end_time = time.time() * 1000
        return RemoveBackgroundResult(
            output_buffer_b64=result['images'][0],
            processing_time_ms=int(end_time - start_time),
            metadata={"width": options.width, "height": options.height, "format": "png"}
        )

    def _invoke_vision_model_for_description(self, base64_image: str, product_name: Optional[str]) -> ProductDescription:
        """Internal method to invoke vision model for description generation."""
        prompt = f"""Act as a high-end fashion copywriter for Hringekjan.is. 
Generate elegant, professional product metadata for a premium second-hand item.

Context:
{f'- Product Name: {product_name}' if product_name else ''}

Instructions:
1. Provide a specific 'Elegant Name' (e.g., 'Tailored Silk Blouse' instead of just 'Shirt').
2. Write a 3-sentence 'Marketing Description' that sounds timeless, sophisticated, and sustainable.
3. Identify the product category (clothing, accessories, etc.).
4. List main colors.
5. Provide a product condition assessment (choose from: new_with_tags, like_new, very_good, good, fair).
6. Suggest relevant SEO keywords.
7. Include a 'Styling Tip'.

Format your response as JSON with keys: short, long, category, colors, condition, keywords, stylingTip"""

        request_body = {
            "max_tokens": 1000,
            "temperature": 0.7,
            "system": [{"text": "You are an expert fashion curator and copywriter for Hringekjan, a premium sustainable marketplace."}],
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png", # Assuming PNG, adjust if needed
                                "data": base64_image
                            }
                        },
                        {
                            "type": "text",
                            "text": prompt
                        }
                    ]
                }
            ]
        }
        
        response = self._vision_client.invoke_model(
            modelId=self.default_vision_model_id,
            contentType='application/json',
            accept='application/json',
            body=json.dumps(request_body)
        )
        response_body = json.loads(response['body'].read().decode('utf-8'))
        analysis_text: str = response_body.get('output', {}).get('message', {}).get('content', [{}])[0].get('text', '')
        if not analysis_text:
            raise ValueError(f"No text content in response from {self.default_vision_model_id}")

        json_match = re.search(r'\{[\s\S]*\}', analysis_text)
        parsed_json = json.loads(json_match.group(0) if json_match else analysis_text)
        
        # Simplified condition validation
        condition = parsed_json.get('condition')
        valid_conditions = get_args(Literal["new_with_tags", "like_new", "very_good", "good", "fair"])
        if condition not in valid_conditions:
            condition = 'very_good'

        return ProductDescription(
            short=parsed_json.get('short', product_name or 'Product'),
            long=parsed_json.get('long', 'High-quality product processed and optimized for sale.'),
            category=parsed_json.get('category', 'General'),
            colors=parsed_json.get('colors') if isinstance(parsed_json.get('colors'), list) else (parsed_json.get('colors').split(',') if parsed_json.get('colors') else ['various']),
            condition=condition,
            keywords=parsed_json.get('keywords') if isinstance(parsed_json.get('keywords'), list) else (parsed_json.get('keywords').split(',') if parsed_json.get('keywords') else ['product']),
            stylingTip=parsed_json.get('stylingTip')
        )
    
    def _translate_description(self, description: ProductDescription) -> ProductDescription:
        """Internal method to translate description."""
        prompt = f"""Translate this product description to Icelandic. Keep the same structure and format.

Short: {description.short}
Long: {description.long}
Category: {description.category or 'General'}
Colors: {', '.join(description.colors) if description.colors else ''}
Condition: {description.condition or ''}
Keywords: {', '.join(description.keywords) if description.keywords else ''}
Styling Tip: {description.stylingTip or ''}

Provide the response in the same JSON format with keys: short, long, category, colors, condition, keywords, stylingTip"""

        request_body = {
            "messages": [
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "max_tokens": 1000,
            "temperature": 0.3
        }

        response = self._translation_client.invoke_model(
            modelId=self.default_translation_model_id,
            contentType='application/json',
            accept='application/json',
            body=json.dumps(request_body)
        )

        response_body = json.loads(response['body'].read().decode('utf-8'))
        translation_text = response_body.get('choices', [{}])[0].get('message', {}).get('content', '') or response_body.get('content', '')

        json_match = re.search(r'\{[\s\S]*\}', translation_text)
        if json_match:
            translation_text = json_match.group(0)
        
        translation_data = json.loads(translation_text)
        
        return ProductDescription(
            short=translation_data.get('short', description.short),
            long=translation_data.get('long', description.long),
            category=translation_data.get('category', description.category),
            colors=translation_data.get('colors') if isinstance(translation_data.get('colors'), list) else description.colors,
            condition=translation_data.get('condition', description.condition),
            keywords=translation_data.get('keywords') if isinstance(translation_data.get('keywords'), list) else description.keywords,
            stylingTip=translation_data.get('stylingTip', description.stylingTip)
        )


    def process_image_from_url(
        self,
        image_url: str = Field(..., description="URL of the image to process."),
        options: ImageProcessingOptions = Field(ImageProcessingOptions(), description="Processing options."),
        product_name: Optional[str] = Field(None, description="Optional name of the product for context.")
    ) -> ProcessImageResult:
        """
        Downloads an image from a URL and processes it, optionally removing the background
        and generating a product description.

        Args:
            image_url: The URL of the image.
            options: Image processing options.
            product_name: Optional name of the product for context.

        Returns:
            A ProcessImageResult object.
        """
        response = requests.get(image_url)
        response.raise_for_status()  # Raise an exception for HTTP errors
        base64_image = base64.b64encode(response.content).decode('utf-8')
        content_type = response.headers.get('content-type', 'image/png')
        
        return self.process_image_from_base64(base64_image, content_type, options, product_name)

    def process_image_from_base64(
        self,
        base64_image: str = Field(..., description="Base64 encoded image string."),
        content_type: str = Field(..., description="Content type of the image (e.g., 'image/png')."),
        options: ImageProcessingOptions = Field(ImageProcessingOptions(), description="Processing options."),
        product_name: Optional[str] = Field(None, description="Optional name of the product for context.")
    ) -> ProcessImageResult:
        """
        Processes a base64 encoded image, optionally removing the background
        and generating a product description.

        Args:
            base64_image: The base64 encoded string of the image.
            content_type: The content type of the image (e.g., 'image/png').
            options: Image processing options.
            product_name: Optional name of the product for context.

        Returns:
            A ProcessImageResult object.
        """
        output_buffer_b64: Optional[str] = None
        bg_removal_res: Optional[RemoveBackgroundResult] = None
        product_desc: Optional[ProductDescription] = None
        bilingual_desc: Optional[BilingualProductDescription] = None

        if options.remove_background:
            try:
                bg_removal_res = self._invoke_bg_removal_model(base64_image, options)
                output_buffer_b64 = bg_removal_res.output_buffer_b64
            except Exception as e:
                print(f"Background removal failed: {e}")
                output_buffer_b64 = base64_image # Fallback to original image
        else:
            output_buffer_b64 = base64_image

        if options.generate_description:
            try:
                product_desc = self._invoke_vision_model_for_description(output_buffer_b64, product_name)
                # Assuming bilingual description is always desired if description generation is on
                icelandic_desc = self._translate_description(product_desc)
                bilingual_desc = BilingualProductDescription(en=product_desc, is_=icelandic_desc)
            except Exception as e:
                print(f"Description generation failed: {e}")

        return ProcessImageResult(
            output_buffer_b64=output_buffer_b64,
            metadata={"content_type": content_type},
            product_description=product_desc,
            bilingual_description=bilingual_desc,
            background_removal_result=bg_removal_res
        )

