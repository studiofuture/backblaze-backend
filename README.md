# Backblaze Backend - Video Hosting Platform

A robust Node.js/Express backend server for video hosting with Backblaze B2 storage, Supabase database, and real-time upload progress tracking via Socket.io.

## 📖 Project Overview

### What is This Project?

This is a **video hosting platform backend** that handles the complete video upload and processing pipeline. It's designed for applications like video sharing platforms, content management systems, or any service that needs to upload, process, and store videos.

### Core Purpose

The backend performs these main functions:

1. **Accept Video Uploads** - Receives video files from frontend applications (React, etc.)
2. **Process Videos** - Extracts metadata (duration, resolution, codec, bitrate) and generates thumbnails
3. **Store Videos** - Uploads videos to Backblaze B2 cloud storage
4. **Store Metadata** - Saves video information to Supabase (PostgreSQL database)
5. **Real-time Updates** - Provides live upload progress via WebSocket (Socket.io)

### Architecture Overview

```
Frontend (React)
    ↓
Express Server (Node.js)
    ↓
    ├─→ Upload Processing (FFmpeg)
    ├─→ Cloud Storage (Backblaze B2)
    ├─→ Database (Supabase)
    └─→ Real-time Updates (Socket.io)
```

### How It Works - Upload Flow Example

**Example: FormData Upload**

```
1. Frontend sends video file
   POST /upload/video
   ↓
2. Server receives file (Busboy parses FormData)
   ↓
3. Extract metadata (FFmpeg analyzes video)
   - Duration: 245 seconds
   - Resolution: 1920x1080
   - Codec: h264
   ↓
4. Generate thumbnail (FFmpeg extracts frame at 5s)
   ↓
5. Upload to Backblaze B2
   - Video → B2 video bucket
   - Thumbnail → B2 thumbnail bucket
   ↓
6. Return response with complete metadata
   {
     videoUrl: "https://...",
     thumbnailUrl: "https://...",
     metadata: {
       duration: 245.973333,
       width: 1920,
       height: 1080,
       codec: "h264",
       ...
     }
   }
```

### Project Structure

```
backblaze-backend/
├── server.js              # Main entry point, Express setup
├── config/                # Configuration (B2, Supabase, etc.)
├── routes/                # API endpoints
│   ├── upload.js         # Upload endpoints
│   ├── video.js          # Video management
│   └── swagger.js        # API documentation
├── services/              # Business logic
│   ├── b2.js             # Backblaze B2 operations
│   ├── ffmpeg.js         # Video processing
│   ├── upload-processor.js # Main upload processing
│   └── multipart-uploader.js # Multipart upload handling
├── utils/                 # Utilities
│   ├── status.js         # Upload status tracking
│   ├── logger.js         # Logging
│   └── memory-monitor.js # Memory monitoring
└── middleware/            # Express middleware
    ├── cors.js           # CORS handling
    └── errorHandler.js   # Error handling
```

### Key Components Explained

#### 1. **Upload Methods** (3 ways to upload videos)
- **FormData Upload**: Traditional multipart/form-data uploads
- **Chunked Upload**: Legacy method for large files (chunks uploaded separately)
- **Multipart Upload**: Streaming proxy (recommended) - server streams chunks directly to B2 without storing full file on server

#### 2. **Video Processing**
- **Metadata Extraction**: Automatically extracts duration, resolution (width/height), codec, bitrate, and file size
- **Thumbnail Generation**: Extracts a frame at 5 seconds to create a thumbnail
- Uses **FFmpeg/FFprobe** for all video processing

#### 3. **Storage & Database**
- **Backblaze B2**: Stores actual video files, thumbnails, and profile pictures
- **Supabase**: Stores video metadata (duration, URLs, etc.) in PostgreSQL database

#### 4. **Real-time Features**
- **Socket.io**: Provides live upload progress updates to frontend
- **Status Tracking**: Tracks upload progress, errors, and completion status

#### 5. **Security Features**
- **Rate Limiting**: Prevents abuse and DDoS attacks
- **CORS Filtering**: Only allows specific origins to access the API
- **Input Validation**: Sanitizes all inputs to prevent injection attacks
- **Security Headers**: Helmet.js integration for secure HTTP headers
- **File Type Validation**: Only accepts video/image files

### Use Case Example

**Scenario**: A user uploads a 500MB video file

1. Frontend sends video in chunks (25MB each)
2. Server streams chunks directly to B2 (low memory usage)
3. Server extracts metadata (duration, resolution, etc.) using FFmpeg
4. Server generates thumbnail from video
5. Server uploads thumbnail to B2
6. Frontend receives complete metadata in response
7. Frontend creates database record with all metadata
8. User sees video with correct duration and thumbnail displayed

### Technologies Used

- **Express.js** - Web framework for Node.js
- **Socket.io** - Real-time bidirectional communication
- **Backblaze B2 SDK** - Cloud storage integration
- **Supabase** - PostgreSQL database with REST API
- **FFmpeg** - Video processing and metadata extraction
- **Busboy** - Form data parsing
- **Helmet** - Security headers middleware
- **express-rate-limit** - Rate limiting middleware

## 🚀 Features

### Upload Methods

#### 1. FormData Upload (`POST /upload/video`)
- **Best for**: Small to medium files (< 100MB)
- **How it works**: 
  - Frontend sends entire file as multipart/form-data
  - Server receives file, extracts metadata, generates thumbnail
  - Uploads to B2 and returns complete metadata
- **Pros**: Simple, single request
- **Cons**: Higher server memory usage for large files

#### 2. Chunked Upload (`POST /upload/chunk` + `POST /upload/complete-chunks`)
- **Best for**: Large files (100MB - 1GB)
- **How it works**:
  - Frontend splits file into chunks (25MB each)
  - Each chunk sent separately to `/upload/chunk`
  - Server assembles chunks on disk
  - When complete, calls `/upload/complete-chunks` to process
- **Pros**: Lower browser memory, can resume uploads
- **Cons**: Server still stores complete file temporarily

#### 3. Streaming Proxy Multipart Upload (`POST /upload/multipart/*`)
- **Best for**: Very large files (1GB+)
- **How it works**:
  - Frontend initializes upload via `/upload/multipart/initialize`
  - Frontend uploads chunks to `/upload/multipart/stream-chunk`
  - Server streams chunks **directly to B2** (never stores on disk)
  - Frontend completes via `/upload/multipart/complete`
  - Server extracts metadata from B2 URL (remote FFprobe)
- **Pros**: Minimal server memory, no disk storage needed
- **Cons**: More complex implementation

### Video Processing Features

#### Metadata Extraction
- **What it extracts**:
  - `duration` - Video length in seconds (float)
  - `width` - Video width in pixels (integer)
  - `height` - Video height in pixels (integer)
  - `codec` - Video codec name (string, e.g., "h264")
  - `bitrate` - Bitrate in bits per second (integer)
  - `size` - File size in bytes (integer)
- **When**: Extracted synchronously before HTTP response
- **How**: Uses FFprobe (part of FFmpeg) to analyze video
- **Location**: `services/ffmpeg.js`

#### Thumbnail Generation
- **What**: Extracts a single frame from video
- **When**: At 5 seconds into video (configurable)
- **Format**: JPEG, high quality (q:v 2)
- **Storage**: Uploaded to B2 thumbnail bucket
- **Fallback**: If generation fails, upload continues without thumbnail

### Real-time Features

#### Socket.io Integration
- **Connection**: Frontend connects to Socket.io server
- **Subscribe**: `socket.emit('subscribe', uploadId)`
- **Updates**: Server emits `status` events with:
  - Progress percentage (0-100)
  - Current stage (receiving, processing, uploading, etc.)
  - Metadata when available
  - Error messages if upload fails
- **Benefits**: Live progress bars, instant error notifications

#### Upload Status Tracking
- **In-memory storage**: Tracks all active uploads
- **Status stages**:
  - `preparing` - Initial setup
  - `receiving` - Receiving file/chunks
  - `processing` - Processing video
  - `extracting_metadata` - Running FFprobe
  - `generating_thumbnail` - Creating thumbnail
  - `uploading` - Uploading to B2
  - `complete` - Finished successfully
  - `error` - Failed with error
- **Retention**: 30 minutes (configurable)

### Security Features

#### Rate Limiting
- **Global**: 1000 requests per 15 minutes per IP
- **Upload endpoints**: 20 requests per 15 minutes per IP
- **Multipart endpoints**: 5 requests per 15 minutes per IP
- **Purpose**: Prevents abuse and DDoS attacks

#### CORS Filtering
- **Strict mode**: Only allows origins in `ALLOWED_ORIGINS`
- **Default origins**: 
  - Production domains (rvshes.com)
  - Development (localhost:3000, localhost:5173)
- **Configurable**: Via environment variables

#### Input Validation
- **File types**: Only video/image MIME types allowed
- **File size**: Configurable max (default: 100GB)
- **String length**: Max 10,000 characters
- **Sanitization**: All inputs sanitized before processing

#### Security Headers
- **Helmet.js**: Adds security headers (XSS protection, etc.)
- **Content Security Policy**: Configurable
- **CORS headers**: Properly configured for cross-origin requests

### Memory Optimization

#### Streaming Proxy Architecture
- **Problem**: Large files (1GB+) would crash server with 512MB RAM
- **Solution**: Server never stores complete file
- **How**: Chunks streamed directly from browser → server → B2
- **Memory usage**: Constant ~25MB regardless of file size

#### Chunk Size Optimization
- **Default**: 25MB chunks
- **Why**: Balance between network efficiency and memory usage
- **Configurable**: Via `CHUNK_SIZE` environment variable

#### Garbage Collection
- **Automatic**: After each upload completes
- **Monitoring**: Memory usage tracked and logged
- **Thresholds**: Warning at 80%, critical at 90%

## 📊 Detailed Flow Diagrams

### Flow 1: FormData Upload

```
┌─────────┐
│Frontend │
└────┬────┘
     │ POST /upload/video (multipart/form-data)
     │ File: video.mp4
     ▼
┌─────────────────┐
│  Express Server │
│  routes/upload  │
└────┬────────────┘
     │
     ▼
┌──────────────────────┐
│ formdata-handler.js  │
│ - Parse FormData     │
│ - Save to temp file  │
└────┬─────────────────┘
     │
     ▼
┌──────────────────────┐
│ upload-processor.js  │
│ Step 1: Extract      │
│   metadata (FFmpeg)  │
└────┬─────────────────┘
     │
     ▼
┌──────────────────────┐
│ upload-processor.js  │
│ Step 2: Generate     │
│   thumbnail (FFmpeg)  │
└────┬─────────────────┘
     │
     ▼
┌──────────────────────┐
│ upload-processor.js  │
│ Step 3: Upload video │
│   to B2              │
└────┬─────────────────┘
     │
     ▼
┌──────────────────────┐
│ upload-processor.js  │
│ Step 4: Upload       │
│   thumbnail to B2    │
└────┬─────────────────┘
     │
     ▼
┌──────────────────────┐
│ Response with        │
│ complete metadata    │
└────┬─────────────────┘
     │
     ▼
┌─────────┐
│Frontend │
│Receives │
│metadata │
└─────────┘
```

### Flow 2: Multipart Upload (Streaming Proxy)

```
┌─────────┐
│Frontend │
└────┬────┘
     │ 1. POST /upload/multipart/initialize
     │    { fileName, fileSize }
     ▼
┌─────────────────┐
│ Express Server  │
│ Creates B2      │
│ upload session  │
└────┬────────────┘
     │ Returns: { uploadId, b2FileId }
     ▼
┌─────────┐
│Frontend │
└────┬────┘
     │ 2. POST /upload/multipart/stream-chunk
     │    Chunk 1 (25MB) → Server → B2
     │    Chunk 2 (25MB) → Server → B2
     │    Chunk 3 (25MB) → Server → B2
     │    ... (repeat for all chunks)
     ▼
┌─────────────────┐
│ Express Server  │
│ Streams chunks  │
│ directly to B2  │
│ (no disk)       │
└────┬────────────┘
     │
     ▼
┌─────────┐
│Frontend │
└────┬────┘
     │ 3. POST /upload/multipart/complete
     │    { uploadId, b2FileId, totalParts }
     ▼
┌─────────────────┐
│ Express Server  │
│ - Finalize B2   │
│ - Extract       │
│   metadata from │
│   B2 URL        │
│ - Generate      │
│   thumbnail     │
│ - Upload        │
│   thumbnail     │
└────┬────────────┘
     │ Returns: { videoUrl, metadata, thumbnailUrl }
     ▼
┌─────────┐
│Frontend │
│Receives │
│complete │
│metadata │
└─────────┘
```

### Flow 3: Real-time Progress Updates

```
┌─────────┐                    ┌──────────────┐
│Frontend │                    │Express Server│
└────┬────┘                    └──────┬───────┘
     │                                 │
     │ socket.emit('subscribe', id)   │
     ├─────────────────────────────────>│
     │                                 │
     │                                 │ Emit status updates
     │<────────────────────────────────┤
     │ socket.on('status', data)      │
     │                                 │
     │ Progress: 0% → 25% → 50% → 100%│
     │                                 │
     │ Status: receiving → processing  │
     │         → uploading → complete  │
     │                                 │
     │ Metadata received when complete│
     │                                 │
```

### Flow 4: Metadata Extraction Process

```
┌─────────────────┐
│ Video File      │
│ (local or URL)  │
└────┬────────────┘
     │
     ▼
┌─────────────────┐
│ FFprobe         │
│ (FFmpeg tool)   │
└────┬────────────┘
     │
     │ Analyzes video:
     │ - Streams (video, audio)
     │ - Format information
     │ - Duration, bitrate, size
     │
     ▼
┌─────────────────┐
│ Extract Data    │
│ - duration      │
│ - width/height  │
│ - codec         │
│ - bitrate       │
│ - size          │
└────┬────────────┘
     │
     ▼
┌─────────────────┐
│ Return Metadata │
│ Object          │
└─────────────────┘
```

### Flow 5: Error Handling

```
┌─────────────────┐
│ Upload Request  │
└────┬────────────┘
     │
     ▼
┌─────────────────┐
│ Try Processing  │
└────┬────────────┘
     │
     ├─── Success ────> Return metadata
     │
     ├─── Error ──────> Catch error
     │                    │
     │                    ▼
     │              ┌─────────────────┐
     │              │ Log error       │
     │              │ Cleanup files   │
     │              │ Update status   │
     │              └────┬────────────┘
     │                   │
     │                   ▼
     │              ┌─────────────────┐
     │              │ Return error    │
     │              │ response        │
     │              └─────────────────┘
     │
     └─── Timeout ────> Kill process
                         Return timeout error
```

## 🔄 Upload Method Comparison

| Feature | FormData | Chunked | Multipart (Streaming) |
|---------|----------|---------|----------------------|
| **Max File Size** | 100GB | 100GB | 100GB |
| **Server Memory** | High | Medium | Low |
| **Server Disk** | Yes (temp) | Yes (temp) | No |
| **Complexity** | Low | Medium | High |
| **Resume Support** | No | Yes | Yes |
| **Best For** | Small files | Medium files | Large files |
| **Chunk Size** | N/A | 25MB | 25MB |
| **Metadata Timing** | Before upload | After assembly | After B2 upload |
| **Thumbnail Source** | Local file | Local file | B2 URL |

## 🎯 Use Cases

### Use Case 1: Small Video Upload (< 50MB)
- **Method**: FormData Upload
- **Flow**: Single request, quick processing
- **Time**: ~10-30 seconds
- **Memory**: ~100MB server memory

### Use Case 2: Medium Video Upload (50MB - 500MB)
- **Method**: Chunked Upload
- **Flow**: Multiple chunk requests, assemble, process
- **Time**: ~1-5 minutes
- **Memory**: ~500MB server memory

### Use Case 3: Large Video Upload (500MB+)
- **Method**: Multipart Streaming Upload
- **Flow**: Stream chunks to B2, extract metadata from URL
- **Time**: ~5-20 minutes
- **Memory**: ~25MB server memory (constant)

### Use Case 4: Batch Uploads
- **Method**: Any (depends on file size)
- **Flow**: Multiple uploads in parallel
- **Rate Limit**: 20 uploads per 15 minutes per IP
- **Background Processing**: Enabled for thumbnails

## 📋 Recent Fixes

### ✅ Metadata Flow Fix (Critical)

**Issue**: Video metadata (duration, width, height, codec, bitrate, size) was being extracted correctly by FFmpeg but the frontend was receiving fallback values (zeros/empty strings) instead of actual metadata.

**Root Causes Identified**:
1. Response formatting in upload routes wasn't ensuring complete metadata structure
2. Metadata sanitization was potentially corrupting the metadata object
3. Metadata wasn't consistently structured with all required fields

**Fixes Applied**:
- ✅ Enhanced response formatting in all upload routes (`/upload/video`, `/upload/multipart/complete`, `/upload/complete-chunks`)
- ✅ Fixed metadata sanitization in `utils/status.js` to preserve all metadata fields
- ✅ Updated service layer to return metadata with complete structure including `videoUrl` and `thumbnailUrl`
- ✅ Added comprehensive logging to trace metadata through the entire response chain

**Metadata Structure** (now guaranteed in all responses):
```json
{
  "metadata": {
    "duration": 245.973333,
    "width": 1920,
    "height": 1080,
    "codec": "h264",
    "bitrate": 8500000,
    "size": 21592737,
    "thumbnailUrl": "https://...",
    "videoUrl": "https://..."
  }
}
```

## 🛠️ Installation

```bash
# Install dependencies
npm install

# Set up environment variables
cp .env.example .env

# Edit .env and fill in your Backblaze B2 credentials
# Required: B2_ACCOUNT_ID, B2_APPLICATION_KEY, B2_VIDEO_BUCKET_ID, etc.
# See .env.example for all available options

# Start server
npm start
# or
yarn dev
```

**Note**: The server will validate environment variables on startup and show which ones are missing or incorrectly formatted.

## ⚙️ Environment Variables

### Quick Setup

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```

2. Edit `.env` and fill in your actual values:
   ```bash
   # Required: Backblaze B2 credentials
   B2_ACCOUNT_ID=your_12_char_account_id_here
   B2_APPLICATION_KEY=your_application_key_here
   B2_VIDEO_BUCKET_ID=your_24_char_video_bucket_id_here
   B2_THUMBNAIL_BUCKET_ID=your_24_char_thumbnail_bucket_id_here
   B2_PROFILE_BUCKET_ID=your_24_char_profile_bucket_id_here
   
   # Optional: Supabase (for database features)
   SUPABASE_URL=https://your-project-id.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here
   
   # Optional: CORS origins
   ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com
   ```

### Required Variables

The server **will not start** without these:

- `B2_ACCOUNT_ID` - Your Backblaze B2 account ID (12 hex characters)
- `B2_APPLICATION_KEY` - Your Backblaze B2 application key
- `B2_VIDEO_BUCKET_ID` - Video bucket ID (24 hex characters)
- `B2_THUMBNAIL_BUCKET_ID` - Thumbnail bucket ID (24 hex characters)
- `B2_PROFILE_BUCKET_ID` - Profile pictures bucket ID (24 hex characters)

### Optional Variables

These have defaults but are recommended:

- `SUPABASE_URL` - For database features (video metadata storage)
- `SUPABASE_SERVICE_ROLE_KEY` - For database operations
- `ALLOWED_ORIGINS` - Comma-separated list of allowed CORS origins
- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment mode (development/production/test)

### Complete Configuration

See `.env.example` for a complete list of all available environment variables with descriptions and default values.

**Important**: Never commit your `.env` file to version control. It contains sensitive credentials.

## 📚 API Documentation

Interactive Swagger/OpenAPI documentation is available at:
- **Swagger UI**: `http://localhost:3000/swagger`
- **Swagger JSON**: `http://localhost:3000/swagger/swagger.json`
- **Swagger YAML**: `http://localhost:3000/swagger/swagger.yaml`

The Swagger documentation includes:
- All API endpoints with request/response schemas
- Metadata structure definitions
- Authentication requirements
- Example requests and responses
- Error response formats

## 📡 API Endpoints

### Upload Endpoints

#### 1. FormData Upload
```http
POST /upload/video
Content-Type: multipart/form-data
```

**Request**:
- `video`: Video file (multipart/form-data)
- `videoId`: (optional) Video ID for database reference

**Response**:
```json
{
  "status": "success",
  "uploadId": "upload_1234567890_abc123",
  "message": "Upload completed successfully",
  "url": "https://...",
  "videoUrl": "https://...",
  "thumbnailUrl": "https://...",
  "metadata": {
    "duration": 245.973333,
    "width": 1920,
    "height": 1080,
    "codec": "h264",
    "bitrate": 8500000,
    "size": 21592737,
    "thumbnailUrl": "https://...",
    "videoUrl": "https://..."
  },
  "uploadComplete": true,
  "publishReady": true,
  "fileSizeMB": 20
}
```

#### 2. Multipart Upload (Streaming Proxy)

**Initialize**:
```http
POST /upload/multipart/initialize
Content-Type: application/json
```

**Request**:
```json
{
  "fileName": "video.mp4",
  "fileSize": 104857600,
  "contentType": "video/mp4",
  "videoId": "optional-video-id",
  "chunkSize": 26214400
}
```

**Response**:
```json
{
  "success": true,
  "uploadId": "multipart_1234567890_abc123",
  "b2FileId": "b2_file_id",
  "fileName": "video_1234567890_abc123.mp4",
  "estimatedParts": 4
}
```

**Stream Chunk**:
```http
POST /upload/multipart/stream-chunk
Headers:
  x-upload-id: multipart_1234567890_abc123
  x-b2-file-id: b2_file_id
  x-part-number: 1
Content-Type: application/octet-stream
```

**Complete**:
```http
POST /upload/multipart/complete
Content-Type: application/json
```

**Request**:
```json
{
  "uploadId": "multipart_1234567890_abc123",
  "b2FileId": "b2_file_id",
  "totalParts": 4,
  "originalFileName": "video.mp4",
  "videoId": "optional-video-id"
}
```

**Response**:
```json
{
  "success": true,
  "uploadId": "multipart_1234567890_abc123",
  "videoUrl": "https://...",
  "fileName": "video_1234567890_abc123.mp4",
  "partsUploaded": 4,
  "fileSize": 104857600,
  "publishReady": true,
  "metadata": {
    "duration": 245.973333,
    "width": 1920,
    "height": 1080,
    "codec": "h264",
    "bitrate": 8500000,
    "size": 21592737,
    "thumbnailUrl": "https://...",
    "videoUrl": "https://..."
  },
  "thumbnailUrl": "https://...",
  "message": "Upload completed successfully with metadata extracted"
}
```

#### 3. Chunked Upload (Legacy)

**Upload Chunk**:
```http
POST /upload/chunk
Headers:
  x-upload-id: upload_1234567890_abc123
  x-chunk-index: 0
  x-total-chunks: 10
Content-Type: application/octet-stream
```

**Complete Chunks**:
```http
POST /upload/complete-chunks
Content-Type: application/json
```

**Request**:
```json
{
  "uploadId": "upload_1234567890_abc123",
  "totalChunks": 10,
  "originalFilename": "video.mp4",
  "videoId": "optional-video-id"
}
```

### Status & Monitoring

#### Get Upload Status
```http
GET /upload/status/:uploadId
```

**Response**:
```json
{
  "status": "complete",
  "progress": 100,
  "stage": "complete",
  "uploadMethod": "streaming_proxy",
  "videoUrl": "https://...",
  "thumbnailUrl": "https://...",
  "metadata": {
    "duration": 245.973333,
    "width": 1920,
    "height": 1080,
    "codec": "h264",
    "bitrate": 8500000,
    "size": 21592737
  },
  "uploadComplete": true,
  "publishReady": true,
  "completedAt": "2024-01-01T00:00:00.000Z"
}
```

#### Health Check
```http
GET /health
```

#### Upload Health
```http
GET /upload/health
```

### Thumbnail Endpoints

#### Generate Thumbnail
```http
POST /upload/generate-thumbnail
Content-Type: application/json
```

**Request**:
```json
{
  "videoUrl": "https://...",
  "seekTime": 5
}
```

#### Upload Custom Thumbnail
```http
POST /upload/thumbnail
Content-Type: multipart/form-data
```

**Request**:
- `thumbnail`: Image file (JPEG, PNG, WebP)
- `videoId`: (optional) Video ID for database update

## 🔌 Socket.io Events

### Client → Server

**Subscribe to Upload**:
```javascript
socket.emit('subscribe', uploadId);
```

**Unsubscribe**:
```javascript
socket.emit('unsubscribe', uploadId);
```

### Server → Client

**Status Update**:
```javascript
socket.on('status', (status) => {
  console.log('Upload status:', status);
  // status contains: status, progress, stage, metadata, videoUrl, thumbnailUrl, etc.
});
```

**Welcome**:
```javascript
socket.on('welcome', (data) => {
  console.log('Connected:', data);
});
```

## 🏗️ Architecture

### Upload Flow (FormData)
```
Frontend → POST /upload/video
  ↓
routes/upload.js
  ↓
services/formdata-handler.js
  ↓
services/upload-processor.js
  ├→ services/ffmpeg.js (extract metadata + thumbnail)
  ├→ services/b2.js (upload video + thumbnail)
  └→ Response with metadata → Frontend
```

### Upload Flow (Multipart)
```
Frontend → POST /upload/multipart/initialize
  ↓
services/multipart-uploader.js
  ↓
Response with uploadId → Frontend
  ↓
[Chunks uploaded via /upload/multipart/stream-chunk]
  ↓
Frontend → POST /upload/multipart/complete
  ↓
services/multipart-uploader.js
  ├→ services/ffmpeg.js (extract metadata from B2 URL)
  ├→ services/ffmpeg.js (generate thumbnail)
  ├→ services/b2.js (upload thumbnail)
  └→ Response with metadata → Frontend
```

## 🔒 Security Features

- **Rate Limiting**: Global and endpoint-specific rate limits
- **CORS Filtering**: Origin validation and whitelisting
- **Input Validation**: Sanitization and size limits
- **Security Headers**: Helmet.js integration
- **Socket Security**: Connection limiting and validation
- **File Type Validation**: Video and image type checking
- **Size Limits**: Configurable file size restrictions

## 📊 Metadata Extraction

The server automatically extracts video metadata using FFmpeg:

- **Duration**: Video length in seconds (float)
- **Width**: Video width in pixels (integer)
- **Height**: Video height in pixels (integer)
- **Codec**: Video codec name (string, e.g., "h264")
- **Bitrate**: Bitrate in bits per second (integer)
- **Size**: File size in bytes (integer)
- **Thumbnail URL**: Generated thumbnail URL
- **Video URL**: Final video storage URL

Metadata is extracted synchronously before the HTTP response is sent, ensuring the frontend always receives complete metadata.

## 🧪 Testing

```bash
# Test CORS
curl http://localhost:3000/cors-test

# Test health
curl http://localhost:3000/health

# Test upload status
curl http://localhost:3000/upload/status/upload_1234567890_abc123
```

## 📝 Logging

The server includes comprehensive logging:
- Upload progress and status
- Metadata extraction results
- Error tracking
- Memory usage monitoring
- Socket.io connection events

## 🚨 Known Issues & Limitations

### Memory Constraints
- **Issue**: Thumbnail generation can cause memory spikes (2-3GB for large videos)
- **Current Hosting**: Render Starter plan (512MB RAM)
- **Recommendation**: Upgrade to Render Standard (2GB RAM) or disable thumbnail generation for large files

### Database Schema
- Ensure Supabase schema uses `storage_url` column (not `url`)
- Duration column should be integer (code rounds float values)

## 📚 Dependencies

- **express**: Web framework
- **socket.io**: Real-time communication
- **backblaze-b2**: B2 storage integration
- **@supabase/supabase-js**: Database integration
- **fluent-ffmpeg**: Video processing
- **busboy**: Form data parsing
- **helmet**: Security headers
- **express-rate-limit**: Rate limiting

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

ISC

## 🆘 Support

For issues or questions:
1. Check the logs for error messages
2. Verify environment variables are set correctly
3. Ensure FFmpeg is installed and accessible
4. Check Backblaze B2 credentials and bucket permissions
5. Verify Supabase connection and schema

## 🔄 Changelog

### Latest (Metadata Fix)
- ✅ Fixed metadata flow in all upload routes
- ✅ Enhanced metadata sanitization
- ✅ Added comprehensive logging
- ✅ Ensured metadata structure consistency

### Previous
- ✅ Fixed thumbnail upload route
- ✅ Fixed database column references
- ✅ Implemented two-phase video deletion
- ✅ Added security enhancements
- ✅ Fixed deployment issues

