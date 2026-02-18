import base64
from typing import List, Optional, Dict, Any, Tuple
import concurrent.futures
import re

import boto3
from pydantic import BaseModel, Field

# --- Pydantic Models ---

class ModerationLabel(BaseModel):
    name: str
    confidence: float

class RekognitionAnalysisResult(BaseModel):
    approved: bool
    reason: Optional[str] = None

    labels: List[str]
    colors: List[str]
    category: str

    brand: Optional[str] = None
    size: Optional[str] = None
    material: Optional[str] = None
    careInstructions: Optional[List[str]] = None

    moderationLabels: List[ModerationLabel]

    rawLabels: List[Dict[str, Any]]
    rawText: List[Dict[str, Any]]

class RekognitionAnalyzer:
    """
    Agent for analyzing images using AWS Rekognition services.
    """
    def __init__(self, region_name: str = 'eu-west-1'):
        self.rekognition_client = boto3.client('rekognition', region_name=region_name)

    def _extract_colors(self, labels: List[Dict[str, Any]]) -> List[str]:
        color_keywords = ['Black', 'White', 'Red', 'Blue', 'Green', 'Yellow', 'Brown', 'Gray', 'Grey', 'Navy', 'Beige', 'Tan', 'Pink', 'Purple', 'Orange', 'Gold', 'Silver']
        
        detected_colors = []
        for label in labels:
            name = label.get('Name')
            if name and any(color in name for color in color_keywords):
                detected_colors.append(name)
        
        return detected_colors[:3] if detected_colors else ['Various']

    def _map_labels_to_category(self, labels: List[Dict[str, Any]]) -> str:
        label_names = [label.get('Name', '').lower() for label in labels]

        # Clothing
        if any(l in label_names for l in ['dress', 'gown']): return 'apparel/dress'
        if any(l in label_names for l in ['jacket', 'coat', 'blazer']): return 'apparel/outerwear'
        if any(l in label_names for l in ['shirt', 'blouse', 'top']): return 'apparel/top'
        if any(l in label_names for l in ['pants', 'jeans', 'trousers']): return 'apparel/bottoms'

        # Accessories
        if any(l in label_names for l in ['bag', 'purse', 'handbag']): return 'accessories/bag'
        if any(l in label_names for l in ['shoe', 'sneaker', 'boot']): return 'accessories/footwear'
        if any(l in label_names for l in ['jewelry', 'necklace', 'ring']): return 'accessories/jewelry'

        # Clothing (generic)
        if any(l in label_names for l in ['clothing', 'apparel']): return 'apparel/general'

        return 'general'

    def _extract_brand(self, text_detections: List[Dict[str, Any]]) -> Optional[str]:
        common_brands = ['ZARA', 'H&M', 'NIKE', 'ADIDAS', 'GUCCI', 'PRADA', 'LOUIS VUITTON', 'CHANEL', 'BURBERRY', 'RALPH LAUREN', 'CALVIN KLEIN', 'TOMMY HILFIGER', 'LEVI', 'GAP', 'UNIQLO', 'MANGO', 'COS']

        for detection in text_detections:
            text = detection.get('DetectedText', '').upper()
            if not text:
                continue

            for brand in common_brands:
                if brand in text:
                    return brand

            if detection.get('Type') == 'LINE' and re.match(r'^[A-Z\s&]{2,15}$', text):
                return text.strip()

        return None

    def _extract_size(self, text_detections: List[Dict[str, Any]]) -> Optional[str]:
        size_patterns = [
            re.compile(r'\b(XXS|XS|S|M|L|XL|XXL|XXXL)\b', re.IGNORECASE),
            re.compile(r'\bSize\s*:?\s*([A-Z]{1,4})\b', re.IGNORECASE),
            re.compile(r'\b(EU|US|UK)\s*(\d{1,2})\b', re.IGNORECASE),
            re.compile(r'\b(\d{1,2})\s*(EU|US|UK)\b', re.IGNORECASE),
            re.compile(r'\b\d{1,2}\/\d{1,2}\b')
        ]

        for detection in text_detections:
            text = detection.get('DetectedText')
            if not text:
                continue

            for pattern in size_patterns:
                match = pattern.search(text)
                if match:
                    return match.group(0).strip()
        return None

    def _extract_material(self, text_detections: List[Dict[str, Any]]) -> Optional[str]:
        material_patterns = [
            re.compile(r'\b\d+%\s*(Cotton|Polyester|Wool|Silk|Leather|Linen|Cashmere|Denim|Nylon|Spandex|Elastane)\b', re.IGNORECASE),
            re.compile(r'\b(100%|Pure)\s*(Cotton|Wool|Silk|Leather|Linen|Cashmere)\b', re.IGNORECASE)
        ]

        for detection in text_detections:
            text = detection.get('DetectedText')
            if not text:
                continue

            for pattern in material_patterns:
                match = pattern.search(text)
                if match:
                    return match.group(0).strip()
        return None

    def _extract_care_instructions(self, text_detections: List[Dict[str, Any]]) -> List[str]:
        care_keywords = ['Machine Wash', 'Hand Wash', 'Dry Clean', 'Do Not Bleach', 'Iron', 'Tumble Dry', 'Line Dry']
        instructions = []

        for detection in text_detections:
            text = detection.get('DetectedText')
            if not text:
                continue
            
            for keyword in care_keywords:
                if keyword.lower() in text.lower():
                    instructions.append(keyword)

        return list(set(instructions))

    def analyze_with_rekognition(
        self,
        image_buffer: Optional[bytes] = Field(None, description="Image buffer bytes."),
        bucket: Optional[str] = Field(None, description="S3 bucket name if image is in S3."),
        key: Optional[str] = Field(None, description="S3 object key if image is in S3.")
    ) -> RekognitionAnalysisResult:
        """
        Runs AWS Rekognition APIs (DetectLabels, DetectText, DetectModerationLabels)
        in parallel on an image.
        """
        if not image_buffer and not (bucket and key):
            raise ValueError("Either image_buffer or both bucket and key must be provided.")

        image_source = {'S3Object': {'Bucket': bucket, 'Name': key}} if bucket and key else {'Bytes': image_buffer}

        def detect_labels_task():
            return self.rekognition_client.detect_labels(
                Image=image_source,
                MaxLabels=15,
                MinConfidence=75
            )

        def detect_text_task():
            return self.rekognition_client.detect_text(
                Image=image_source,
                Filters={'RegionsOfInterest': []}
            )

        def detect_moderation_labels_task():
            return self.rekognition_client.detect_moderation_labels(
                Image=image_source,
                MinConfidence=60
            )

        with concurrent.futures.ThreadPoolExecutor() as executor:
            future_labels = executor.submit(detect_labels_task)
            future_text = executor.submit(detect_text_task)
            future_moderation = executor.submit(detect_moderation_labels_task)

            labels_response = future_labels.result()
            text_response = future_text.result()
            moderation_response = future_moderation.result()

        # Process labels
        labels_raw = labels_response.get('Labels', [])
        labels = [l.get('Name') for l in labels_raw if l.get('Name')]
        colors = self._extract_colors(labels_raw)
        category = self._map_labels_to_category(labels_raw)

        # Process text detections
        text_detections_raw = text_response.get('TextDetections', [])
        brand = self._extract_brand(text_detections_raw)
        size = self._extract_size(text_detections_raw)
        material = self._extract_material(text_detections_raw)
        care_instructions = self._extract_care_instructions(text_detections_raw)

        # Process moderation
        moderation_labels_raw = moderation_response.get('ModerationLabels', [])
        moderation_labels = [
            ModerationLabel(name=l.get('Name'), confidence=l.get('Confidence'))
            for l in moderation_labels_raw if l.get('Name') and l.get('Confidence') is not None
        ]

        # Check if approved (reject if high-confidence inappropriate content)
        is_inappropriate = any(
            l.confidence > 80 and any(keyword in l.name for keyword in ['Explicit', 'Violence', 'Suggestive'])
            for l in moderation_labels
        )

        return RekognitionAnalysisResult(
            approved=not is_inappropriate,
            reason=f"Content moderation failed: {moderation_labels[0].name}" if is_inappropriate and moderation_labels else None,
            labels=labels,
            colors=colors,
            category=category,
            brand=brand,
            size=size,
            material=material,
            careInstructions=care_instructions,
            moderationLabels=moderation_labels,
            rawLabels=labels_raw,
            rawText=text_detections_raw
        )
