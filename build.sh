#!/usr/bin/env bash
# Exit on error
set -e

echo "🔄 Starting build process..."

# Install FFmpeg (required for video processing)
echo "📦 Installing FFmpeg..."
apt-get update -y
apt-get install -y ffmpeg

# Verify FFmpeg installation
echo "✅ Verifying FFmpeg installation..."
ffmpeg -version

# Install Node.js dependencies (use ci for faster, deterministic installs)
echo "📦 Installing Node.js dependencies..."
npm ci --only=production

# Create required directories
echo "📁 Creating required directories..."
mkdir -p uploads/thumbs uploads/temp

# Set proper permissions
echo "🔐 Setting directory permissions..."
chmod 755 uploads uploads/thumbs uploads/temp

echo "✅ Build completed successfully!"
