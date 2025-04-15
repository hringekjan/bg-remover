#!/bin/bash
set -e

# --- Configuration ---
MONOREPO_SERVICE_DIR="./services/bg-remover"
STANDALONE_REPO_URL="git@github.com:hringekjan/bg-remover.git"
STANDALONE_BRANCH="main"
TEMP_DIR="bg-remover-standalone-temp-sync"
VERSION="v0.1.0"
COMMIT_MESSAGE="Sync code from monorepo release ${VERSION}"

# Get the absolute path of the script's directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
# Monorepo root is three levels up from the script directory
MONOREPO_ROOT="$(cd "$SCRIPT_DIR/../../.." &> /dev/null && pwd)"

# --- Helper Functions ---
echo_error() {
    echo -e "\033[0;31mError: $1\033[0m" >&2
}
echo_info() {
    echo -e "\033[0;32m$1\033[0m"
}
echo_warning() {
    echo -e "\033[1;33mWarning: $1\033[0m"
}

# --- Main Logic ---
echo_info "Starting sync of ${MONOREPO_SERVICE_DIR} to ${STANDALONE_REPO_URL}"

# Ensure we are in the monorepo root
cd "$MONOREPO_ROOT"

# Check if source directory exists
if [ ! -d "$MONOREPO_SERVICE_DIR" ]; then
    echo_error "Source directory not found: ${MONOREPO_ROOT}/${MONOREPO_SERVICE_DIR}"
    exit 1
fi

# Clean up temp directory if it exists from a previous failed run
if [ -d "$TEMP_DIR" ]; then
    echo_warning "Removing existing temporary directory: ${TEMP_DIR}"
    rm -rf "$TEMP_DIR"
fi

# Clone the standalone repository
echo_info "Cloning ${STANDALONE_REPO_URL} into ${TEMP_DIR}..."
git clone "$STANDALONE_REPO_URL" "$TEMP_DIR"
if [ $? -ne 0 ]; then echo_error "Failed to clone standalone repository."; exit 1; fi

# Copy files from monorepo service dir to temp dir using rsync
echo_info "Syncing files from ${MONOREPO_SERVICE_DIR} to ${TEMP_DIR}..."
rsync -av --delete --exclude='.git/' --exclude='.DS_Store' --exclude='__pycache__/' --exclude='output/' --exclude='input/' --exclude='.venv/' "${MONOREPO_SERVICE_DIR}/" "${TEMP_DIR}/"
if [ $? -ne 0 ]; then echo_error "Failed to sync files with rsync."; exit 1; fi

# Navigate into the temp directory
cd "$TEMP_DIR"

# Check if there are any changes
echo_info "Checking for changes..."
git add .
if git diff --staged --quiet; then
    echo_info "No changes detected. Standalone repository is up-to-date."
    cd ..
    rm -rf "$TEMP_DIR"
    echo_info "Sync complete (no changes)."
    exit 0
fi

# Commit changes
echo_info "Changes detected. Committing with message: ${COMMIT_MESSAGE}"
git commit -m "${COMMIT_MESSAGE}"
if [ $? -ne 0 ]; then echo_error "Failed to commit changes."; exit 1; fi

# Tag the release
echo_info "Tagging commit with ${VERSION}..."
git tag -a "${VERSION}" -m "Release ${VERSION}"
if [ $? -ne 0 ]; then echo_error "Failed to tag commit."; exit 1; fi

# Push changes to the standalone repository
echo_info "Pushing changes to ${STANDALONE_BRANCH} branch..."
git push origin "${STANDALONE_BRANCH}"
if [ $? -ne 0 ]; then echo_error "Failed to push commit."; exit 1; fi

# Push the tag
echo_info "Pushing tag ${VERSION}..."
git push origin "${VERSION}"
if [ $? -ne 0 ]; then echo_error "Failed to push tag."; exit 1; fi

# Clean up
echo_info "Cleaning up temporary directory..."
cd ..
rm -rf "$TEMP_DIR"

echo_info "Successfully synced and pushed version ${VERSION} to standalone repository."

exit 0 