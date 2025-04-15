#!/bin/bash
set -e

# Change to the root directory of the service
cd "$(dirname "$0")/.."

# Ensure the test directories exist
mkdir -p tests/test_input tests/test_output

# Add the current directory to PYTHONPATH
export PYTHONPATH=$PYTHONPATH:$(pwd)

# Run pytest
python -m pytest tests/ -v 