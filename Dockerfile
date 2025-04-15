FROM python:3.9-slim-buster

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY processor.py .

# Create input and output directories
RUN mkdir -p /app/input /app/output

# Set environment variables
ENV INPUT_DIR=/app/input
ENV OUTPUT_DIR=/app/output
ENV MODEL_NAME=u2net
ENV NUM_WORKERS=2

# Run the application
CMD ["python", "processor.py"]

# Docker healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import os; sys.exit(0 if os.path.exists('/app/processor.py') else 1)" 