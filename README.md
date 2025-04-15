# Background Remover Service

A microservice for automatically removing backgrounds from images using the [rembg](https://github.com/danielgatis/rembg) library.

## Purpose

This service monitors a specified input directory for new image files. When an image appears, it automatically processes the image to remove its background and saves the result to an output directory.

## Features

-   Monitors an input directory for new images (`.jpg`, `.jpeg`, `.png`, `.heic`).
-   Uses the `rembg` library with a configurable model (`u2net`, `u2netp`, etc.) for background removal.
-   Saves processed images (as PNG) to an output directory.
-   Handles image processing sequentially as files are detected by the filesystem watcher (`watchdog`).
-   Configuration is managed via environment variables.
-   Supports HEIC image format (requires `pillow-heif`).

## Prerequisites

-   **Operating System:** macOS, Linux, or Windows (with WSL2 recommended).
-   **Git:** Required to clone the repository. You need to install this *before* running the installation script.
-   **Docker & Docker Compose:**
    -   Docker Engine or Docker Desktop must be installed and running.
    -   Docker Compose V2 (usually included with recent Docker installations, accessed via `docker compose`) is recommended. The install script will check for this and the legacy `docker-compose` and provide guidance if neither is found.

## Setup & Installation

1.  **Clone the Repository:**
    ```bash
    # Replace <repository-url> with the actual URL
    git clone <repository-url>
    cd <repository-name>/services/bg-remover
    ```

2.  **Run the Installation Script:**
    This script checks prerequisites, prepares the environment (`.env` file), builds the Docker image, and starts the service.
    ```bash
    cd ../scripts # Navigate to the script directory relative to bg-remover
    bash ./install.sh
    ```
    *(Note: The install script location might change based on where we decide to put it. This assumes it's in `bg-remover/scripts/`)*

    The script will guide you if Docker or Docker Compose are missing or not running.

## Configuration

Configuration is handled via an `.env` file in the `bg-remover` directory. The installation script copies the template `.env.example` to `.env` if `.env` doesn't exist. You may want to customize the `.env` file before or after running the install script.

| Variable      | Description                                                     | Default     |
| :------------ | :-------------------------------------------------------------- | :---------- |
| `INPUT_DIR`   | Container path to monitor for input images                      | `/app/input`  |
| `OUTPUT_DIR`  | Container path to save processed images                         | `/app/output` |
| `MODEL_NAME`  | The `rembg` model to use (e.g., `u2net`, `u2netp`, `isnet-general-use`) | `u2net`     |
| `NUM_WORKERS` | (Currently unused - processing is sequential via watchdog)      | `1`         |

**Important:** The `INPUT_DIR` and `OUTPUT_DIR` paths *inside the container* are mapped to local directories on your host machine via the `docker-compose.yml` file. By default, it maps the local `./input` and `./output` directories relative to `bg-remover`.

## Usage

1.  **Place Images:** Copy or move your `.jpg`, `.jpeg`, `.png`, or `.heic` files into the `bg-remover/input` directory on your host machine.
2.  **Check Output:** The service will process the images, and the resulting background-removed PNG files will appear in the `bg-remover/output` directory.
3.  **View Logs:** To see the service's activity or troubleshoot errors, view the Docker logs:
    ```bash
    # Run this from the bg-remover directory
    docker compose logs -f
    # Or if using legacy docker-compose:
    # docker-compose logs -f
    ```

## Dependencies

### Key Python Libraries:

-   `rembg`: Core library for background removal.
-   `watchdog`: For monitoring the input directory for file changes.
-   `Pillow`: Image processing library.
-   `pillow-heif`: Adds HEIC support to Pillow.
-   `python-dotenv`: For loading environment variables from the `.env` file.

### Base Docker Image:

-   `python:3.10-slim` (or as specified in the `Dockerfile`)

## Development (Optional)

### Setting Up Local Environment (Without Docker)

1.  Ensure Python 3.10+ is installed.
2.  Create and activate a virtual environment:
    ```bash
    python -m venv .venv
    source .venv/bin/activate  # Linux/macOS
    # .venv\Scripts\activate    # Windows
    ```
3.  Install dependencies:
    ```bash
    pip install -r requirements.txt
    ```
4.  Create an `.env` file from `.env.example` and configure it.
5.  Run the processor directly:
    ```bash
    python processor.py
    ```

### Running Tests

Pytest is used for testing.

```bash
# Ensure dependencies are installed in your virtual environment
# Run from the 'bg-remover' directory
pytest tests/
```

## Project Structure

```
bg-remover/
├── .env.example        # Environment variable template
├── .env                # Local environment variables (created by script/user)
├── Dockerfile          # Docker image definition
├── docker-compose.yml  # Docker Compose configuration
├── input/              # Default host directory for input images
├── output/             # Default host directory for output images
├── processor.py        # Main processing script
├── README.md           # This file
├── requirements.txt    # Python dependencies
├── scripts/
│   └── install.sh      # Installation script (to be created)
└── tests/              # Unit/Integration tests
```

## License

MIT 