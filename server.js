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
// *** FINAL CONFIRMED CONFIGURATION & STATUSES ***
// *******************************************************************

const SUPABASE_TABLE_NAME = 'story_script'; 
const VIDEO_DATA_COLUMN_NAME = 'script_data'; 

// CONFIRMED STATUSES
const STATUS_PENDING = 'PENDING'; // Used by worker to find job
const STATUS_IN_PROGRESS = 'PROCESSING_RENDER'; // Used by worker/server during rendering
const STATUS_COMPLETED = 'RENDERING_COMPLETE'; // Final success status
const STATUS_FAILED = 'FAILED'; // Final failure status

// *******************************************************************

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: Supabase credentials missing.");
}

/**
 * Placeholder for video upload logic (Replace with actual Supabase Storage integration).
 * For now, this just simulates an upload and returns a fixed URL.
 */
async function uploadVideoToStorage(scriptId, tempFilePath) {
    console.log(`[STORAGE] Simulating upload of ${tempFilePath} for job ${scriptId}...`);
    
    // In a real app, you would use the @supabase/storage-js SDK here.
    // Since we don't have the library, we just delete the file and return the placeholder URL.
    try {
        await fs.unlink(tempFilePath);
        console.log(`[STORAGE] Cleaned up temp file: ${tempFilePath}`);
    } catch (e) {
        console.error(`[STORAGE] Failed to clean up temp file:`, e);
    }
    
    // The actual URL where the client will find the video (must be accessible)
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
            console.error(`Supabase Response Error:`, errorText); 
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
 * Builds the actual FFmpeg command string.
 */
function buildFFmpegCommand(videoData) {
    const outputFileName = `output_${videoData.id}.mp4`;
    const tempFilePath = path.join('/tmp', outputFileName);
    
    console.log(`Building FFmpeg command for environment: ${videoData.environment_tag}`);

    // --- LOGIC FOR THE 2D/3D MISMATCH FIX (SIMULATED) ---
    const sceneTitle = videoData.title || "Untitled Story";
    const characterName = videoData.main_character_names[0] || "Default Character";
    let videoDuration = 5; // Fixed duration for testing
    
    let textOverlay = `Text='Title: ${sceneTitle} | Character: ${characterName}';`;
    
    if (videoData.environment_tag === '2D') {
         // Placeholder for a 2D rendering command
         textOverlay += `Text='WARNING: 2D Assets Missing - Rendering Default Placeholder';`;
    } else {
        // Placeholder for a 3D rendering command
        textOverlay += `Text='3D Render Starting...';`;
    }
    
    // FINAL, WORKING COMMAND: Creates a 5-second video with a text overlay
    // The video file is saved to the /tmp directory.
    const command = `ffmpeg -f lavfi -i color=c=blue:s=1280x720:d=${videoDuration} -vf "drawtext=${textOverlay}fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2" -c:v libx264 -pix_fmt yuv420p -y ${tempFilePath}`;
    
    return { command, tempFilePath };
}


/**
 * Executes the FFmpeg command in a child process.
 */
function executeFFmpeg(command, tempFilePath, scriptId) {
    return new Promise((resolve, reject) => {
        console.log(`Executing FFmpeg for job ${scriptId}. Output: ${tempFilePath}`);
        
        const ffmpeg = spawn('ffmpeg', command.split(' ').slice(1)); 
        let stderr = '';
        
        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
            // In a real app, you would parse data.toString() for FFmpeg 'frame=' progress
            // and call updateJobStatus to show progress_percentage updates.
        });
        
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                console.log(`FFmpeg Job ${scriptId} finished successfully. Video saved to: ${tempFilePath}`);
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

// --- /RENDER ENDPOINT (STEP 1: QUEUES JOB) ---
app.post('/render', async (req, res) => {
    const { videoData, scriptId } = req.body; 

    if (!videoData || !scriptId) {
        return res.status(400).send({ error: 'Missing videoData or scriptId.' });
    }
    
    // Status is PENDING for the worker to find it
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
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'Prefer': 'resolution=merge-duplicates'
            },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Supabase queue insert failed:`, errorText);
            return res.status(500).send({ error: 'Failed to queue job' });
        }
        
        res.status(202).send({ success: true, message: `FFmpeg job queued successfully for script ${scriptId}` });
        console.log(`Job ${scriptId} queued successfully with status ${STATUS_PENDING}`);
        
    } catch (error) {
        console.error('Queue error:', error);
        res.status(500).send({ error: 'Internal server error' });
    }
});


// --- /PROCESS ENDPOINT (STEP 3: EXECUTED BY SUPABASE WORKER) ---
app.post('/process', async (req, res) => {
    const { videoData, scriptId } = req.body; 

    if (!videoData || !scriptId) {
        return res.status(400).send({ error: 'Missing videoData or scriptId.' });
    }

    console.log(`Processing job ${scriptId}: ${videoData.title}`);

    // Respond immediately so the Supabase worker doesn't time out
    res.status(202).send({ 
        success: true, 
        message: `Processing started for script ${scriptId}` 
    });

    // Start background processing
    (async () => {
        let tempFilePath = '';
        try {
            // 1. Update status to show work has started (using correct status)
            await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 10);

            // 2. Build FFmpeg command and get the output path
            const { command, tempFilePath: path } = buildFFmpegCommand(videoData);
            tempFilePath = path; // Save path for cleanup
            await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 25);

            // 3. Execute FFmpeg
            const executionResult = await executeFFmpeg(command, tempFilePath, scriptId);
            await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 75);

            // 4. Upload result to Supabase storage
            const finalVideoUrl = await uploadVideoToStorage(scriptId, tempFilePath);
            await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 90);

            // 5. Mark job complete (using correct status)
            await updateJobStatus(scriptId, STATUS_COMPLETED, 100, null, finalVideoUrl);

            console.log(`Job ${scriptId} completed successfully. URL: ${finalVideoUrl}`);

        } catch (error) {
            console.error(`Job ${scriptId} failed:`, error);
            // 6. Mark job as failed if any step throws an error
            await updateJobStatus(scriptId, STATUS_FAILED, 0, error.message);
            // Attempt to clean up temp file on failure
            if (tempFilePath) {
                 try { await fs.unlink(tempFilePath); } catch (e) { console.warn(`Failed to cleanup temp file on error:`, e); }
            }
        }
    })();
});

app.get('/', (req, res) => res.send('Storyloom Render Server Ready'));
app.listen(PORT, () => console.log(`Render Server listening on port ${PORT}`));
