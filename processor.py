#!/usr/bin/env python3
import os
import time
import logging
from pathlib import Path
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from rembg import remove
from PIL import Image
import dotenv

# Try to import pillow_heif for HEIC support
try:
    import pillow_heif
    pillow_heif.register_heif_opener()
    HEIC_SUPPORT = True
except ImportError:
    HEIC_SUPPORT = False
    logging.warning(
        "pillow-heif not installed, HEIC files will not be supported"
    )

# Load environment variables
dotenv.load_dotenv()

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Get environment variables
INPUT_DIR = os.getenv('INPUT_DIR', '/app/input')
OUTPUT_DIR = os.getenv('OUTPUT_DIR', '/app/output')
MODEL_NAME = os.getenv('MODEL_NAME', 'u2net')
NUM_WORKERS = int(os.getenv('NUM_WORKERS', '1'))

# Supported image formats
SUPPORTED_FORMATS = ['.jpg', '.jpeg', '.png']
if HEIC_SUPPORT:
    SUPPORTED_FORMATS.append('.heic')


class ImageProcessor:
    def __init__(self, input_dir, output_dir, model_name):
        self.input_dir = Path(input_dir)
        self.output_dir = Path(output_dir)
        self.model_name = model_name
        
        # Ensure directories exist
        self.input_dir.mkdir(exist_ok=True, parents=True)
        self.output_dir.mkdir(exist_ok=True, parents=True)
        
        logger.info(f"Using model: {self.model_name}")
        logger.info(f"Monitoring input directory: {self.input_dir}")
        logger.info(f"Output directory: {self.output_dir}")
        logger.info(f"Supported formats: {', '.join(SUPPORTED_FORMATS)}")
    
    def process_image(self, input_path):
        """Process a single image to remove background"""
        try:
            # Create output path - maintain same filename with png extension
            input_path = Path(input_path)
            filename = input_path.name
            output_filename = f"{input_path.stem}.png"
            output_path = self.output_dir / output_filename
            
            logger.info(f"Processing image: {filename}")
            
            # Handle HEIC files
            suffix = input_path.suffix.lower()
            if suffix == '.heic' and HEIC_SUPPORT:
                logger.info(f"Converting HEIC image: {filename}")
                input_image = Image.open(input_path)
            else:
                # Regular image formats
                input_image = Image.open(input_path)
            
            # Remove background
            output_image = remove(input_image)
            
            # Save output image
            output_image.save(output_path)
            
            logger.info(f"Background removed: {output_filename}")
            return True
        except Exception as e:
            logger.error(f"Error processing {input_path}: {str(e)}")
            return False

    def process_existing_files(self):
        """Process any existing files in the input directory"""
        count = 0
        for file_path in self.input_dir.glob("*.*"):
            if file_path.suffix.lower() in SUPPORTED_FORMATS:
                if self.process_image(file_path):
                    count += 1
        
        if count > 0:
            logger.info(f"Processed {count} existing images")
        else:
            logger.info("No existing images to process")


class ImageWatcher(FileSystemEventHandler):
    def __init__(self, processor):
        self.processor = processor
    
    def on_created(self, event):
        if not event.is_directory:
            file_path = event.src_path
            if Path(file_path).suffix.lower() in SUPPORTED_FORMATS:
                self.processor.process_image(file_path)


def main():
    # Initialize processor
    processor = ImageProcessor(INPUT_DIR, OUTPUT_DIR, MODEL_NAME)
    
    # Process any existing files
    processor.process_existing_files()
    
    # Set up file system watcher
    event_handler = ImageWatcher(processor)
    observer = Observer()
    observer.schedule(event_handler, INPUT_DIR, recursive=False)
    observer.start()
    
    logger.info(
        f"Background removal service started with {NUM_WORKERS} worker(s)"
    )
    
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()


if __name__ == "__main__":
    main() 