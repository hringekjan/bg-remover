#!/bin/bash
set -e

# Script to download necessary files and run the bg-remover service via Docker Compose.

# --- Configuration ---
INSTALL_DIR="bg-remover-service"
REPO_OWNER="hringekjan"
REPO_NAME="bg-remover"
BRANCH="main" # Or specify a tag/commit hash

# Base URL for raw content
RAW_BASE_URL="https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}"

# Files to download (relative to repo root)
FILES=(
    "docker-compose.yml"
    "Dockerfile"
    ".env.example"
    "processor.py"
    "requirements.txt"
)

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
download_file() {
    local file_path="$1"
    local download_url="${RAW_BASE_URL}/${file_path}"
    echo_info "Downloading '${file_path}' from URL: ${download_url}"
    if command -v curl &> /dev/null; then
        curl -fsSL "${download_url}" -o "${file_path}"
    elif command -v wget &> /dev/null; then
        wget -q "${download_url}" -O "${file_path}"
    else
        echo_error "Neither curl nor wget found. Cannot download files."
        exit 1
    fi
    if [ $? -ne 0 ] || [ ! -s "${file_path}" ]; then
        echo_error "Failed to download or file empty: ${file_path} from ${download_url}"
        exit 1
    fi
}

# --- Prerequisite Checks (Host) ---
echo_info "Checking prerequisites..."

# Check curl or wget
if ! command -v curl &> /dev/null && ! command -v wget &> /dev/null; then
     echo_error "This script requires either 'curl' or 'wget' to download files."
     exit 1
fi

# OS Detection (Informational - Copied from install.sh)
OS_NAME="$(uname -s)"
case "${OS_NAME}" in
    Linux*)     MACHINE=Linux;; 
    Darwin*)    MACHINE=Mac;; 
    CYGWIN*)    MACHINE=Cygwin;; 
    MINGW*)     MACHINE=MinGw;; 
    MSYS_NT*)   MACHINE=Msys;; 
    *)          MACHINE="UNKNOWN:${OS_NAME}"
 esac
IS_WSL=false
if [[ "$MACHINE" == "Linux" ]] && grep -qi microsoft /proc/version; then IS_WSL=true; fi

# Check Docker Command
if ! check_command docker; then
    echo_error "Docker command is required but not found."
    if [[ "$MACHINE" == "Mac" ]]; then
        echo_info "Attempting to install Docker using Homebrew..."
        if check_command brew; then
            if ! brew list --cask docker &> /dev/null; then
                echo_info "Docker cask not found via Homebrew. Installing..."
                if brew install --cask docker; then
                    echo_info "Docker cask installed successfully via Homebrew."
                    echo_warning "Please launch Docker Desktop manually for the first time if needed."
                else
                    echo_error "Failed to install Docker cask via Homebrew."
                    echo_error "Please install Docker Desktop manually: https://www.docker.com/products/docker-desktop/"
                    exit 1
                fi
            else
                echo_info "Docker cask already installed via Homebrew."
            fi
        else
            echo_error "Homebrew ('brew') command not found. Cannot automatically install Docker."
            echo_info "Please install Homebrew first (see https://brew.sh/) and then install Docker manually: https://www.docker.com/products/docker-desktop/"
            exit 1
        fi
    # Original guidance for other OSes
    elif [[ "$MACHINE" == "Linux" ]] && [[ "$IS_WSL" == "false" ]]; then echo "Install Docker Engine: https://docs.docker.com/engine/install/";
    elif [[ "$IS_WSL" == "true" ]] || [[ "$MACHINE" =~ ^(Cygwin|MinGw|Msys)$ ]]; then echo "Install Docker Desktop for Windows (enable WSL2): https://www.docker.com/products/docker-desktop/";
    else echo "Consult Docker installation guide: https://docs.docker.com/engine/install/"; fi
    exit 1
fi

# Check Docker Daemon
if ! docker info > /dev/null 2>&1; then
    echo_warning "Docker daemon is not running."
    if [[ "$MACHINE" == "Mac" ]]; then
        echo_info "Attempting to start Docker Desktop..."
        if open -a Docker; then
            echo_info "Attempted to launch Docker Desktop. Waiting for daemon to start (up to 60 seconds)..."
            # Poll for Docker daemon readiness
            timeout_seconds=60
            interval_seconds=3
            end_time=$(( $(date +%s) + timeout_seconds ))
            docker_ready=false
            while [[ $(date +%s) -lt $end_time ]]; do
                if docker info > /dev/null 2>&1; then
                    docker_ready=true
                    break
                fi
                echo -n "."
                sleep $interval_seconds
            done
            echo # Newline after dots

            if [[ "$docker_ready" == "true" ]]; then
                echo_info "Docker daemon is now running."
            else
                echo_error "Docker daemon did not start within ${timeout_seconds} seconds."
                echo_error "Please ensure Docker Desktop can start properly and try again."
                exit 1
            fi
        else
            echo_error "Failed to launch Docker Desktop using 'open -a Docker'."
            echo_error "Please start Docker Desktop manually and try again."
            exit 1
        fi
    else
        echo_error "Please start Docker Desktop or the Docker service manually."
        exit 1
    fi
fi
echo_info "Docker daemon is running."

# Check Docker Compose Command
DOCKER_COMPOSE_CMD=""
if command -v docker &> /dev/null && docker compose version &> /dev/null; then DOCKER_COMPOSE_CMD="docker compose";
elif command -v docker-compose &> /dev/null; then DOCKER_COMPOSE_CMD="docker-compose";
else
    echo_error "Docker Compose command not found (neither 'docker compose' nor 'docker-compose')."
    # (Guidance message based on OS - same as install.sh)
    if [[ "$MACHINE" == "Mac" ]] || [[ "$IS_WSL" == "true" ]] || [[ "$MACHINE" =~ ^(Cygwin|MinGw|Msys)$ ]]; then echo "Ensure Docker Desktop is up-to-date.";
    elif [[ "$MACHINE" == "Linux" ]]; then echo "Install Docker Compose plugin/standalone: https://docs.docker.com/compose/install/"; fi
    exit 1
fi
echo_info "Using '$DOCKER_COMPOSE_CMD' for Docker Compose."

# --- Setup --- 
echo_info "Setting up installation directory: ${INSTALL_DIR}"

mkdir -p "${INSTALL_DIR}"
cd "${INSTALL_DIR}"

# Download necessary files
echo_info "Downloading required files..."
for file in "${FILES[@]}"; do
    download_file "$file"
done

# Create input/output dirs
mkdir -p input
mkdir -p output
echo_info "Created input/ and output/ directories."

# Setup .env file
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    cp .env.example .env
    echo_info "Created .env file from .env.example."
    echo_warning "Default settings will be used. You may want to customize the .env file in the '${INSTALL_DIR}' directory later."
elif [ -f ".env" ]; then
    echo_info ".env file already exists. Skipping creation."
else
    # This case should ideally not be reached if .env.example download succeeds
    echo_warning ".env.example was not found or download failed. Cannot create default .env file."
fi

# --- Run Service ---
echo_info "Building and starting the background remover service..."

if $DOCKER_COMPOSE_CMD build && $DOCKER_COMPOSE_CMD up -d; then
    INSTALL_PATH=$(pwd)
    echo_info "-----------------------------------------------------"
    echo_info "Background Remover service started successfully!"
    echo_info "-----------------------------------------------------"
    echo "Service files are located in: ${INSTALL_PATH}"
    echo "Place images to process in: ${INSTALL_PATH}/input"
    echo "Processed images will appear in: ${INSTALL_PATH}/output"
    echo "To view logs: cd \"${INSTALL_PATH}\" && ${DOCKER_COMPOSE_CMD} logs -f"
    echo "To stop the service: cd \"${INSTALL_PATH}\" && ${DOCKER_COMPOSE_CMD} down"
    echo "-----------------------------------------------------"
else
    echo_error "Failed to start Docker containers. Check logs above for details."
    exit 1
fi

exit 0 