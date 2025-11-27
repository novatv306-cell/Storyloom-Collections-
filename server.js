const express = require('express');
// CRITICAL: We need 'child_process' to run the FFmpeg command
const { spawn } = require('child_process'); 

// --- Configuration from Environment Variables ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const PORT = process.env.PORT || 3000;

// *******************************************************************
// *** FINAL CONFIRMED CONFIGURATION ***
// *******************************************************************

// 1. Table Name (The collection of scripts)
const SUPABASE_TABLE_NAME = 'story_script'; 

// 2. Column Name (The JSON data field - Renamed to 'script_data')
const VIDEO_DATA_COLUMN_NAME = 'script_data'; 

// *******************************************************************

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: Supabase credentials missing.");
}

/**
 * Updates existing job in the Supabase table using PATCH
 * Note: videoData is only needed here to provide mandatory fields for the initial QUEUE
 */
async function updateJobStatus(scriptId, status, progress_percentage, error_message = null, final_video_url = null) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return false;

    // Build the payload with minimal, necessary fields
    const payload = { 
        status: status, 
        progress_percentage: progress_percentage,
        error_message: error_message,
        final_video_url: final_video_url,
    };
    
    console.log(`Updating Supabase job ${scriptId} to ${status} (${progress_percentage}%)...`);

    try {
        // Use PATCH to update existing row by ID
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE_NAME}?id=eq.${scriptId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'Prefer': 'return=minimal' // Ensures a faster response
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
 * Placeholder function: Builds the FFmpeg command string based on videoData.
 * NOTE: The App Builder must implement the complex logic here later.
 */
function buildFFmpegCommand(videoData) {
    console.log(`Building FFmpeg command for character: ${videoData.main_character_names[0] || 'Default'}`);
    
    // *** Placeholder Command: This must be replaced by your App Builder ***
    // This is a simple, generic command that outputs a black screen with text.
    // It is just for testing the architecture.
    const outputFileName = `output_${videoData.id}.mp4`;
    const command = `ffmpeg -f lavfi -i color=c=black:s=1280x720:d=5 -vf "drawtext=text='Rendering Job ${videoData.id} Start!':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2" -y /tmp/${outputFileName}`;
    
    return command;
}


/**
 * Executes the FFmpeg command in a child process (from the App Builder's code).
 */
function executeFFmpeg(command, scriptId) {
    return new Promise((resolve, reject) => {
        console.log(`Executing FFmpeg for job ${scriptId}: ${command}`);
        
        // Split the command string into 'ffmpeg' and its arguments
        const ffmpeg = spawn('ffmpeg', command.split(' ').slice(1)); 
        
        let stderr = '';
        
        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
            // TODO: App Builder can add logic here to parse progress from FFmpeg output
        });
        
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                console.log(`FFmpeg Job ${scriptId} finished successfully.`);
                resolve({ success: true, outputFilePath: `/tmp/output_${scriptId}.mp4` });
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
    
    // Add mandatory fields for queuing (no need for error checking, just inserting)
    const payload = { 
        id: scriptId,
        status: 'QUEUED', 
        progress_percentage: 0.0,
        error_message: null,
        title: videoData.title || "Untitled Video",
        full_script: videoData.full_script || "Script data missing.",
        environment_tag: videoData.environment_tag || "2D",
        content_type: videoData.content_type || "cartoon",
        main_character_names: videoData.main_character_names || [] // FINAL FIX
    };
    
    // Store the main data payload
    payload[VIDEO_DATA_COLUMN_NAME] = videoData;

    try {
        // Use POST with Prefer: resolution=merge-duplicates for initial insert/update
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE_NAME}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'Prefer': 'resolution=merge-duplicates' // Insert if new, update if ID exists
            },
            body: JSON.stringify(payload)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Supabase queue insert failed:`, errorText);
            return res.status(500).send({ error: 'Failed to queue job' });
        }
        
        res.status(202).send({ success: true, message: `FFmpeg job queued successfully for script ${scriptId}` });
        console.log(`Job ${scriptId} queued successfully`);
        
    } catch (error) {
        console.error('Queue error:', error);
        res.status(500).send({ error: 'Internal server error' });
    }
});


// --- /PROCESS ENDPOINT (STEP 3: EXECUTED BY SUPABASE WORKER) ---
app.post('/process', async (req, res) => {
    const { videoData, scriptId } = req.body; // Data is sent here by the Supabase Worker

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
        try {
            // 1. Update status to show work has started
            await updateJobStatus(scriptId, 'IN_PROGRESS', 25);

            // 2. Build and execute FFmpeg command
            const ffmpegCommand = buildFFmpegCommand(videoData);
            await updateJobStatus(scriptId, 'IN_PROGRESS', 50); // Progress update after command is built

            const executionResult = await executeFFmpeg(ffmpegCommand, scriptId);
            await updateJobStatus(scriptId, 'IN_PROGRESS', 90); // Progress update after execution

            // 3. TODO: In a real app, upload the file (executionResult.outputFilePath) to Supabase storage here.
            const finalVideoUrl = `https://supabase.storage.io/videos/${scriptId}.mp4`; 
            
            // 4. Mark job complete
            await updateJobStatus(scriptId, 'RENDERING_COMPLETE', 100, null, finalVideoUrl);

            console.log(`Job ${scriptId} completed successfully`);

        } catch (error) {
            console.error(`Job ${scriptId} failed:`, error);
            // 5. Mark job as failed if any step throws an error
            await updateJobStatus(scriptId, 'RENDERING_FAILED', 0, error.message);
        }
    })();
});

app.get('/', (req, res) => res.send('Storyloom Render Server Ready'));
app.listen(PORT, () => console.log(`Render Server listening on port ${PORT}`));
