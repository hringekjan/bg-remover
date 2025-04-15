import os
import sys
import pytest
from pathlib import Path
import shutil
from PIL import Image

# Add parent directory to path
parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if parent_dir not in sys.path:
    sys.path.insert(0, parent_dir)

# Import processor module
from processor import ImageProcessor


@pytest.fixture
def test_dirs():
    # Create test directories
    test_input = Path("tests/test_input")
    test_output = Path("tests/test_output")
    
    # Ensure test directories exist
    test_input.mkdir(exist_ok=True, parents=True)
    test_output.mkdir(exist_ok=True, parents=True)
    
    # Clean output directory
    for item in test_output.glob('*'):
        if item.is_file():
            item.unlink()
    
    yield test_input, test_output
    
    # Cleanup
    shutil.rmtree(test_input, ignore_errors=True)
    shutil.rmtree(test_output, ignore_errors=True)


@pytest.fixture
def test_image(test_dirs):
    test_input, _ = test_dirs
    
    # Create a simple test image
    img_path = test_input / "test_image.jpg"
    img = Image.new('RGB', (100, 100), color='red')
    img.save(img_path)
    
    return img_path


def test_image_processor_init(test_dirs):
    test_input, test_output = test_dirs
    
    # Test processor initialization
    processor = ImageProcessor(test_input, test_output, "u2net")
    
    assert processor.input_dir == test_input
    assert processor.output_dir == test_output
    assert processor.model_name == "u2net"
    assert test_input.exists()
    assert test_output.exists()


def test_process_existing_files(test_dirs, test_image, monkeypatch):
    test_input, test_output = test_dirs
    
    # Mock the process_image method to avoid actual processing
    processed_files = []
    
    class MockImageProcessor(ImageProcessor):
        def process_image(self, input_path):
            processed_files.append(Path(input_path).name)
            return True
    
    # Initialize processor and process files
    processor = MockImageProcessor(test_input, test_output, "u2net")
    processor.process_existing_files()
    
    # Check if our test image was processed
    assert "test_image.jpg" in processed_files
    assert len(processed_files) == 1 