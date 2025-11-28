const express = require('express');
// CRITICAL: We need 'child_process' to run the FFmpeg command
const { spawn } = require('child_process'); 
const fs = require('fs/promises'); // Needed to manage temporary video file
const path = require('path');

// --- Configuration from Environment Variables ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const PORT = process.env.PORT || 3000;

// *******************************************************************
// *** FINAL CONFIRMED CONFIGURATION AND STATUSES ***
// *******************************************************************

const SUPABASE_TABLE_NAME = 'story_script'; 
const VIDEO_DATA_COLUMN_NAME = 'script_data'; 

// CONFIRMED STATUSES (These match the worker and the database expectations)
const STATUS_PENDING = 'PENDING'; 
const STATUS_IN_PROGRESS = 'PROCESSING_RENDER'; 
const STATUS_COMPLETED = 'RENDERING_COMPLETE'; 
const STATUS_FAILED = 'FAILED'; 

// --- DEBUG FLAG IS NOW SET TO FALSE ---
const DEBUG_SKIP_PROCESSING = false; 
console.log(`PRODUCTION MODE: DEBUG_SKIP_PROCESSING is set to ${DEBUG_SKIP_PROCESSING}. FFmpeg execution is ENABLED.`);

// *******************************************************************

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: Supabase credentials missing.");
}

/**
 * Placeholder for video upload logic.
 */
async function uploadVideoToStorage(scriptId, tempFilePath) {
    console.log(`[STORAGE] Simulating upload of ${tempFilePath} for job ${scriptId}...`);
    
    // Clean up the local file after "uploading"
    try {
        await fs.unlink(tempFilePath);
        console.log(`[STORAGE] Cleaned up temp file: ${tempFilePath}`);
    } catch (e) {
        console.warn(`[STORAGE] Clean up warning: File not found at ${tempFilePath}. This is expected if FFmpeg failed early.`);
    }
    
    // Returns a placeholder URL for the database (replace with your real storage URL later)
    return `https://your-supabase-storage-bucket.com/videos/story_${scriptId}.mp4`;
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
    
    console.log(`Updating Supabase job ${scriptId} to ${status} (${progress_percentage}%)...`);

    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE_NAME}?id=eq.${scriptId}`, {
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
            console.error(`Supabase UPDATE failed: ${response.status}`);
            const errorText = await response.text();
            console.error(`Supabase Response Error (Status ${status}):`, errorText); 
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
 * Builds the actual FFmpeg command arguments array (FIXED).
 */
function buildFFmpegCommand(videoData) {
    if (!videoData) {
        throw new Error("videoData is missing or null for FFmpeg command builder.");
    }

    const outputFileName = `output_${videoData.id || Date.now()}.mp4`;
    const tempFilePath = path.join('/tmp', outputFileName);
    
    const sceneTitle = videoData.title || "Untitled Story";
    let videoDuration = 5; 
    
    // Combine the title text and escape all spaces for FFmpeg filter syntax.
    const textContent = `Job ${videoData.id} Complete! Title: ${sceneTitle}`;
    // *** CRITICAL FIX: Replace every space with an escaped space (\ ) for FFmpeg's drawtext filter ***
    const escapedText = textContent.replace(/ /g, '\\ ');
    
    // Use the escaped text in the drawtext filter.
    const drawtextFilter = `drawtext=text=${escapedText}:fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2`;

    // Define the arguments as a clean array.
    const args = [
        '-f', 'lavfi',
        '-i', `color=c=blue:s=1280x720:d=${videoDuration}`,
        '-vf', drawtextFilter, 
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv444p',
        '-y', // Overwrite output file if it exists
        tempFilePath // The final output path
    ];
    
    return { args, tempFilePath };
}


/**
 * Executes the FFmpeg command in a child process (FIXED).
 */
function executeFFmpeg(args, tempFilePath, scriptId) {
    return new Promise((resolve, reject) => {
        console.log(`Executing FFmpeg command for job ${scriptId} with args:`, args);
        // Pass the clean array of arguments directly to spawn
        const ffmpeg = spawn('ffmpeg', args); 
        let stderr = '';
        
        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                console.log(`FFmpeg Job ${scriptId} completed successfully.`);
                resolve({ success: true, tempFilePath });
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

    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE_NAME}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_SERVICE_KEY
