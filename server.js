const express = require('express');
const { spawn } = require('child_process'); 
const fs = require('fs/promises'); 
const path = require('path');

// --- Supabase Client Library Import ---
const { createClient } = require('@supabase/supabase-js');

// --- Configuration from Environment Variables ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const PORT = process.env.PORT || 3000;

// *******************************************************************

const SUPABASE_TABLE_NAME = 'story_script'; 
const VIDEO_DATA_COLUMN_NAME = 'script_data'; 
const SUPABASE_STORAGE_BUCKET = 'story-videos'; // ASSUMPTION: Your bucket name is 'story-videos'

const STATUS_PENDING = 'PENDING'; 
const STATUS_IN_PROGRESS = 'PROCESSING_RENDER'; 
const STATUS_COMPLETED = 'RENDERING_COMPLETE'; 
const STATUS_FAILED = 'FAILED'; 

const DEBUG_SKIP_PROCESSING = false; 
console.log(`PRODUCTION MODE: DEBUG_SKIP_PROCESSING is set to ${DEBUG_SKIP_PROCESSING}. FFmpeg execution is ENABLED.`);

// Initialize Supabase Client (Service Role for file uploads)
const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY 
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) 
    : { storage: { from: () => ({ upload: () => Promise.reject(new Error('Supabase client not initialized')) }) } };

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: Supabase credentials missing.");
}

/**
 * Handles cleanup of temporary files (video) and uploads to Supabase Storage.
 */
async function cleanupTempFile(tempFilePath) {
    let finalVideoUrl = null;
    if (tempFilePath) {
        // We now attempt the real upload before cleanup
        try {
            const scriptId = path.basename(tempFilePath).split('_')[1].split('.')[0];
            finalVideoUrl = await uploadVideoToStorage(scriptId, tempFilePath);
        } catch (e) {
            console.warn(`[STORAGE] Upload failed/cleanup warning: ${e.message}`);
        }
    }
    return finalVideoUrl;
}


/**
 * Uploads the video file to Supabase Storage and cleans up the local file.
 * This function is now performing the REAL upload.
 */
async function uploadVideoToStorage(scriptId, tempFilePath) {
    const storagePath = `public/${scriptId}.mp4`;
    let finalVideoUrl = null;
    
    // 1. Check the file size to confirm it's a valid video
    try {
        const stats = await fs.stat(tempFilePath);
        console.log(`[STORAGE] FINAL CHECK: Video file size: ${stats.size} bytes.`);
        if (stats.size === 0) {
            throw new Error("Generated file size is zero. Not uploading.");
        }
        
        // 2. Read the file into a buffer
        const videoBuffer = await fs.readFile(tempFilePath);

        // 3. Upload to Supabase Storage
        console.log(`[STORAGE] Starting REAL upload to bucket '${SUPABASE_STORAGE_BUCKET}' at path '${storagePath}'...`);
        
        const { data, error } = await supabase.storage
            .from(SUPABASE_STORAGE_BUCKET)
            .upload(storagePath, videoBuffer, {
                contentType: 'video/mp4',
                upsert: true,
            });

        if (error) {
            throw new Error(`Supabase upload failed: ${error.message}`);
        }

        // 4. Get the public URL
        const { data: publicUrlData } = supabase.storage
            .from(SUPABASE_STORAGE_BUCKET)
            .getPublicUrl(storagePath);

        if (publicUrlData && publicUrlData.publicUrl) {
            finalVideoUrl = publicUrlData.publicUrl;
            console.log(`[STORAGE] SUCCESS: Video uploaded. Public URL: ${finalVideoUrl}`);
        } else {
            throw new Error('Could not retrieve public URL after upload.');
        }

    } catch (e) {
        console.error(`[STORAGE] UPLOAD ERROR for job ${scriptId}:`, e.message);
        // This log is critical if the Supabase client library is missing.
        if (e.message.includes('createClient')) {
            console.error("CRITICAL: The @supabase/supabase-js library may not be installed in your Render environment.");
        }
        throw e; 
    }
    
    // 5. Clean up the local video file
    try {
        await fs.unlink(tempFilePath);
        console.log(`[STORAGE] Cleaned up temp video file: ${tempFilePath}`);
    } catch (e) {
        console.warn(`[STORAGE] Clean up warning: Video file not found at ${tempFilePath}.`);
    }
    
    return finalVideoUrl;
}


/**
 * Updates existing job status in the Supabase table using PATCH
 */
async function updateJobStatus(scriptId, status, progress_percentage, error_message = null, final_video_url = null) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return false;

    const payload = { 
        status: status, 
        progress_percentage: progress_percentage,
        error_message: error_message,
        final_video_url: final_video_url,
    };
    
    const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE_NAME}?id=eq.${scriptId}`;

    try {
        const response = await fetch(url, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'Prefer': 'return=minimal' 
            },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            console.error(`Supabase UPDATE failed: ${response.status}`, await response.text());
            return false;
        }
        
        console.log(`Supabase UPDATE successful. Job ${scriptId} is now ${status}.`);
        return true;

    } catch (e) {
        console.error(`Failed to update job status:`, e);
            return false;
    }
}

/**
 * Builds the FFmpeg command for the video.
 */
function buildFFmpegCommand(videoData) {
    if (!videoData) {
        throw new Error("videoData is missing or null for FFmpeg command builder.");
    }

    const scriptId = videoData.id || Date.now();
    const outputFileName = `output_${scriptId}.mp4`;
    const tempFilePath = path.join('/tmp', outputFileName);
    const videoDuration = 5; 
    
    // FINAL CONFIRMED ARCHITECTURE: Remote Image Overlay for the black caption bar
    const captionImageUrl = 'https://placehold.co/1280x100/000000/000000.png'; 
    
    console.log(`Generating FINAL PRODUCTION COMMAND for Job ${scriptId}. Caption Bar is being overlaid.`);
    
    const args = [
        // Input 0: Main Video Stream (Blue Screen Placeholder)
        '-f', 'lavfi',
        '-i', `color=c=blue:s=1280x720:d=${videoDuration}`, 
        
        // Input 1: Caption Image URL (FFmpeg will download this image)
        '-i', captionImageUrl, 
        
        // Filter Complex: Overlay the caption image (Input 1) onto the main video (Input 0)
        '-filter_complex', '[0][1]overlay=x=0:y=H-h[v]', 
        '-map', '[v]', // Map the final video stream
        
        // Encoding
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv444p',
        '-y', // Overwrite output file if it exists
        tempFilePath // The final output path
    ];
    
    return { args, tempFilePath };
}


/**
 * Executes the FFmpeg command in a child process.
 */
function executeFFmpeg(args, scriptId) {
    return new Promise((resolve, reject) => {
        console.log(`Executing FFmpeg command for job ${scriptId} with args:`, args);
        const ffmpeg = spawn('ffmpeg', args); 
        let stderr = '';
        
        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                console.log(`FFmpeg Job ${scriptId} completed successfully.`);
                resolve({ success: true });
            } else {
                reject(new Error(`FFmpeg exited with code ${code}. Error Output: ${stderr}`));
            }
        });
        
        ffmpeg.on('error', (err) => {
            reject(new Error(`Failed to start FFmpeg: ${err.message}`));
        });
    });
}


const app = express();
app.use(express.json());

// --- /RENDER ENDPOINT (Queueing) ---
app.post('/render', async (req, res) => {
    const { videoData, scriptId } = req.body; 
    if (!videoData || !scriptId) return res.status(400).send({ error: 'Missing videoData or scriptId.' });
    
    const payload = { 
        id: scriptId,
        status: STATUS_PENDING, 
        progress_percentage: 0.0,
        error_message: null,
        title: videoData.title || "Untitled Video",
        full_script: videoData.full_script || "Script data missing.",
        environment_tag: videoData.environment_tag || "2D",
        content_type: videoData.content_type || "cartoon",
        main_character_names: videoData.main_character_names || []
    };
    payload[VIDEO_DATA_COLUMN_NAME] = videoData;
    
    const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE_NAME}`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'Prefer': 'resolution=merge-duplicates'
            },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            console.error(`Supabase queue insert failed: ${response.status}`, await response.text());
            return res.status(500).send({ error: 'Failed to queue job' });
        }
        
        res.status(202).send({ success: true, message: `FFmpeg job queued successfully for script ${scriptId}` });
    } catch (error) {
        console.error('Queue error:', error);
        res.status(500).send({ error: 'Internal server error' });
    }
});


// --- /PROCESS ENDPOINT (Execution) ---
app.post('/process', async (req, res) => {
    const { videoData, scriptId } = req.body; 
    if (!videoData || !scriptId) return res.status(400).send({ error: 'Missing videoData or scriptId.' });

    res.status(202).send({ 
        success: true, 
        message: `Processing started for script ${scriptId}` 
    });

    // Start background processing
    (async () => {
        let tempFilePath = '';
        try {
            // 1. Set status to IN_PROGRESS
            await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 10);

            if (DEBUG_SKIP_PROCESSING) { return; }
            
            // 2. Build FFmpeg command arguments
            const commandData = buildFFmpegCommand(videoData);
            tempFilePath = commandData.tempFilePath;

            await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 25);

            // 3. Execute FFmpeg
            await executeFFmpeg(commandData.args, scriptId); 
            await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 75);

            // 4. Upload result and clean up temporary file (REAL UPLOAD)
            const finalVideoUrl = await cleanupTempFile(tempFilePath);
            await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 90);

            // 5. Set final completion status and save the real video URL.
            await updateJobStatus(scriptId, STATUS_COMPLETED, 100, null, finalVideoUrl);

        } catch (error) {
            console.error(`Job ${scriptId} failed:`, error);
            // 6. Set failure status and attempt cleanup
            await updateJobStatus(scriptId, STATUS_FAILED, 0, error.message);
            // Ensure cleanup runs even on failure
            await cleanupTempFile(tempFilePath); 
        }
    })();
});

app.get('/', (req, res) => res.send('Storyloom Render Server Ready'));
app.listen(PORT, () => console.log(`Render Server listening on port ${PORT}`));
