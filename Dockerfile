# Dockerfile for Backend Service

# Use an official Python runtime as a parent image
FROM python:3.11-slim

# Set environment variables to prevent Python from writing pyc files
# and prevent buffering stdout/stderr
ENV PYTHONDONTWRITEBYTECODE 1
ENV PYTHONUNBUFFERED 1

# Set the working directory in the container
WORKDIR /app

# Install system dependencies that might be needed by Python packages (e.g., opencv)
# Add any other required system libs here if installation fails later
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install pip dependencies
# Copy only requirements first to leverage Docker cache
COPY requirements.txt .
# Ensure pip, setuptools, and wheel are up-to-date
RUN pip install --upgrade pip setuptools wheel
# Install project dependencies (allow pip to resolve latest compatible versions)
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application code into the container
# Use .dockerignore to exclude unnecessary files/dirs (like venv, .git, etc.)
COPY . .

# Make port 8001 available to the world outside this container
EXPOSE 8001

# Define the command to run the application
# Use 0.0.0.0 to allow connections from outside the container
CMD ["uvicorn", "src.api:app", "--host", "0.0.0.0", "--port", "8001"]

# Docker healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import os; sys.exit(0 if os.path.exists('/app/processor.py') else 1)" 