#!/usr/bin/env bash
# Exit on error
set -e

# Install FFmpeg
echo "Installing FFmpeg..."
apt-get update -y
apt-get install -y ffmpeg

# Verify FFmpeg installation
echo "Verifying FFmpeg installation..."
ffmpeg -version

# Continue with normal build
echo "Installing Node.js dependencies..."
npm install

echo "Build completed successfully!"