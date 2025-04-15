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

### Standard Setup (Within Monorepo)

Use this method if you have cloned the main `carousel-fresh` monorepo and want to run the service from within its structure.

1.  **Navigate to the Service Directory:**
    Make sure you are in the `services/bg-remover` directory within the cloned monorepo.

2.  **Run the Local Installation Script:**
    This script checks prerequisites (Docker), prepares the environment (`.env` file), builds the Docker image, and starts the service.
    ```bash
    # Run from the services/bg-remover directory
    bash scripts/install.sh 
    ```
    The script will guide you if Docker or Docker Compose are missing or not running.

### Alternative: Quick Install (Standalone Service Only)

Use this method if you *only* want this background remover service and not the rest of the monorepo. This command downloads and executes an installation script that sets up the service in a *new, separate directory* named `bg-remover-service`.

```bash
curl -sSL https://raw.githubusercontent.com/hringekjan/bg-remover/main/scripts/quick_install.sh | bash
```

**Notes for Quick Install:**
*   Run this command in the directory where you want the `bg-remover-service` folder to be created.
*   Requires `curl` or `wget` on your system.
*   The script checks for Docker/Docker Compose.
*   This installation will *not* be part of the monorepo structure.

## Configuration

Configuration is handled via an `.env`