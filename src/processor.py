#!/usr/bin/env python3
import os
import time
import logging
import glob
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from rembg import remove
from PIL import Image

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('bg-remover')

# Get environment variables
INPUT_DIR = os.environ.get('INPUT_DIR', '/app/input')
OUTPUT_DIR = os.environ.get('OUTPUT_DIR', '/app/output')
MODEL_NAME = os.environ.get('MODEL_NAME', 'u2net')
NUM_WORKERS = int(os.environ.get('NUM_WORKERS', '2'))

# Ensure directories exist
os.makedirs(INPUT_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Keep track of processed files
processed_files = set()

def process_image(input_path):
    """Process a single image to remove background"""
    try:
        filename = os.path.basename(input_path)
        output_path = os.path.join(OUTPUT_DIR, filename)
        
        # Skip if already processed
        if input_path in processed_files:
            return
        
        # Skip if not an image file
        if not filename.lower().endswith(('.png', '.jpg', '.jpeg')):
            logger.info(f"Skipping non-image file: {filename}")
            return
            
        # Wait if file is still being written
        file_size = -1
        while file_size != os.path.getsize(input_path):
            file_size = os.path.getsize(input_path)
            time.sleep(0.5)
        
        logger.info(f"Processing: {filename}")
        
        input_image = Image.open(input_path)
        output_image = remove(input_image, model_name=MODEL_NAME)
        output_image.save(output_path)
        
        logger.info(f"Completed: {filename}")
        processed_files.add(input_path)
    except Exception as e:
        logger.error(f"Error processing {input_path}: {str(e)}")

def process_existing_files():
    """Process any existing files in the input directory"""
    image_files = glob.glob(os.path.join(INPUT_DIR, "*.png")) + \
                  glob.glob(os.path.join(INPUT_DIR, "*.jpg")) + \
                  glob.glob(os.path.join(INPUT_DIR, "*.jpeg"))
    
    if not image_files:
        logger.info("No existing files to process")
        return
    
    logger.info(f"Found {len(image_files)} existing files to process")
    
    # Process images in parallel
    with ThreadPoolExecutor(max_workers=NUM_WORKERS) as executor:
        executor.map(process_image, image_files)

class ImageHandler(FileSystemEventHandler):
    def __init__(self, executor):
        self.executor = executor
        super().__init__()
    
    def on_created(self, event):
        if event.is_directory:
            return
        
        # Check if the file is an image
        if event.src_path.lower().endswith(('.png', '.jpg', '.jpeg')):
            logger.info(f"New file detected: {event.src_path}")
            self.executor.submit(process_image, event.src_path)

def main():
    """Main entry point for the application."""
    logger.info("Starting background removal service")
    logger.info(f"Input directory: {INPUT_DIR}")
    logger.info(f"Output directory: {OUTPUT_DIR}")
    logger.info(f"Model: {MODEL_NAME}")
    logger.info(f"Workers: {NUM_WORKERS}")
    
    # Create output directory if it doesn't exist
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    # Process existing files
    process_existing_files()
    
    # Create thread pool executor
    executor = ThreadPoolExecutor(max_workers=NUM_WORKERS)
    
    # Set up file watcher
    event_handler = ImageHandler(executor)
    observer = Observer()
    observer.schedule(event_handler, INPUT_DIR, recursive=False)
    observer.start()
    
    try:
        logger.info("Watching for new files...")
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
        executor.shutdown()
        logger.info("Service stopped")
    
    observer.join()

if __name__ == "__main__":
    main() 