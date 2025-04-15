#!/bin/bash
set -e

# --- Configuration ---
# Get the directory where the script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
# Assume the project root (bg-remover) is one level up
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." &> /dev/null && pwd)"

# --- Helper Functions ---
echo_error() {
    echo -e "\033[0;31mError: $1\033[0m" >&2
}

echo_warning() {
    echo -e "\033[1;33mWarning: $1\033[0m"
}

echo_info() {
    echo -e "\033[0;32m$1\033[0m"
}

check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo_error "'$1' command not found."
        return 1
    fi
    return 0
}

# --- Prerequisite Checks ---
echo_info "Checking prerequisites..."

# 1. OS Detection (Informational)
OS_NAME="$(uname -s)"
case "${OS_NAME}" in
    Linux*)     MACHINE=Linux;; 
    Darwin*)    MACHINE=Mac;; 
    CYGWIN*)    MACHINE=Cygwin;; 
    MINGW*)     MACHINE=MinGw;; 
    MSYS_NT*)   MACHINE=Msys;; 
    *)          MACHINE="UNKNOWN:${OS_NAME}"
 esac

# Attempt to detect WSL more reliably
IS_WSL=false
if [[ "$MACHINE" == "Linux" ]] && grep -qi microsoft /proc/version; then
    IS_WSL=true
    echo_info "Detected Windows Subsystem for Linux (WSL)."
elif [[ "$MACHINE" == "Linux" ]]; then
    echo_info "Detected Linux."
elif [[ "$MACHINE" == "Mac" ]]; then
    echo_info "Detected macOS."
else
    echo_warning "Could not reliably determine OS or running on unsupported OS ($MACHINE). Prerequisite guidance may be inaccurate."
fi

# 2. Check Docker Command
if ! check_command docker; then
    echo "Docker command is required but not found." 
    if [[ "$MACHINE" == "Mac" ]]; then
        echo "Please install Docker Desktop for Mac. You can download it from: https://www.docker.com/products/docker-desktop/"
        echo "Alternatively, if you use Homebrew: brew install --cask docker"
    elif [[ "$MACHINE" == "Linux" ]] && [[ "$IS_WSL" == "false" ]]; then
        echo "Please install Docker Engine for your Linux distribution." 
        echo "Follow the official instructions at: https://docs.docker.com/engine/install/"
    elif [[ "$IS_WSL" == "true" ]] || [[ "$MACHINE" =~ ^(Cygwin|MinGw|Msys)$ ]]; then
        echo "Please install Docker Desktop for Windows and ensure WSL2 integration is enabled."
        echo "Download it from: https://www.docker.com/products/docker-desktop/"
    else
        echo "Please consult the Docker installation guide for your OS: https://docs.docker.com/engine/install/"
    fi
    exit 1
fi

# 3. Check Docker Daemon
echo_info "Checking if Docker daemon is running..."
if ! docker info > /dev/null 2>&1; then
    echo_error "Docker daemon is not running."
    echo "Please start Docker Desktop or the Docker service."
    exit 1
fi
echo_info "Docker daemon is running."

# 4. Check Docker Compose Command
DOCKER_COMPOSE_CMD=""
if command -v docker &> /dev/null && docker compose version &> /dev/null; then
    echo_info "Found Docker Compose V2 (docker compose)."
    DOCKER_COMPOSE_CMD="docker compose"
elif command -v docker-compose &> /dev/null; then
    echo_info "Found legacy Docker Compose (docker-compose)."
    DOCKER_COMPOSE_CMD="docker-compose"
else
    echo_error "Docker Compose command not found (neither 'docker compose' nor 'docker-compose')."
    if [[ "$MACHINE" == "Mac" ]] || [[ "$IS_WSL" == "true" ]] || [[ "$MACHINE" =~ ^(Cygwin|MinGw|Msys)$ ]]; then
        echo "Ensure Docker Desktop is installed and up-to-date. It usually includes Docker Compose."
    elif [[ "$MACHINE" == "Linux" ]]; then
        echo "You might need to install the Docker Compose plugin or the standalone version."
        echo "See: https://docs.docker.com/compose/install/"
    fi
    exit 1
fi

# --- Environment Setup ---
echo_info "Setting up environment..."
cd "$PROJECT_DIR"

ENV_EXAMPLE_FILE=".env.example"
ENV_FILE=".env"

if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$ENV_EXAMPLE_FILE" ]; then
        cp "$ENV_EXAMPLE_FILE" "$ENV_FILE"
        echo_info "Created .env file from $ENV_EXAMPLE_FILE."
        echo_warning "You may want to customize the settings in the .env file."
    else
        echo_warning "$ENV_EXAMPLE_FILE not found. Cannot create .env file automatically."
    fi
else
    echo_info ".env file already exists. Skipping creation."
fi

# --- Build and Run ---
echo_info "Building and starting the Docker containers with '$DOCKER_COMPOSE_CMD'..."

# Use the determined Docker Compose command
if $DOCKER_COMPOSE_CMD up --build -d; then
    echo_info "Background Remover service started successfully!"
    echo "- Place images in the '$PROJECT_DIR/input' directory."
    echo "- Processed images will appear in '$PROJECT_DIR/output' directory."
    echo "- View logs with: cd '$PROJECT_DIR' && $DOCKER_COMPOSE_CMD logs -f"
else
    echo_error "Failed to start Docker containers."
    exit 1
fi

# --- Make script executable (run this manually once) ---
# chmod +x install.sh 