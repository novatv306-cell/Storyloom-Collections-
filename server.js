const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { spawn } = require('child_process'); 
const { promises: fs } = require('fs'); 
const path = require('path');

// --- Configuration ---
// These variables are loaded from the Render environment
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const PORT = process.env.PORT || 3000;

const SUPABASE_TABLE_NAME = 'story_script'; 
const SUPABASE_STORAGE_BUCKET = 'generated-content'; 

// CRITICAL CONFIRMED COLUMN NAMES:
const VIDEO_DATA_COLUMN_NAME = 'script_data'; 
const LOGO_VIDEO_URL_COLUMN = 'logo_video_url'; 

const POLLING_INTERVAL_MS = 5000; // Check for new jobs every 5 seconds

const STATUS_PENDING = 'PENDING'; 
const STATUS_IN_PROGRESS = 'PROCESSING_RENDER'; 
const STATUS_COMPLETED = 'RENDERING_COMPLETE'; 
const STATUS_FAILED = 'FAILED'; 

// Placeholder URLs for FFmpeg inputs
const CAPTION_IMAGE_URL = 'https://placehold.co/1280x100/000000/FFFFFF.png?text=Placeholder+Caption'; 
const FALLBACK_LOGO_URL = 'https://placehold.co/100x100/191970/FFFFFF.png?text=LOGO';

// Initialize Supabase Client
const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY 
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }) 
    : {};

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: Supabase credentials missing. App cannot access database.");
    // We allow the Express server to start but fail database operations.
}

// =========================================================
// === WORKER UTILITIES (Database and File Handling) =======
// =========================================================

async function uploadVideoToStorage(scriptId, tempFilePath) {
    const storagePath = `public/${scriptId}.mp4`;
    let finalVideoUrl = null;
    try {
        const stats = await fs.stat(tempFilePath);
        if (stats.size === 0) throw new Error("Generated file size is zero. Not uploading.");
        const videoBuffer = await fs.readFile(tempFilePath);
        
        const { error } = await supabase.storage.from(SUPABASE_STORAGE_BUCKET).upload(storagePath, videoBuffer, { contentType: 'video/mp4', upsert: true });
        if (error) throw new Error(`Supabase upload failed: ${error.message}`);

        const { data: publicUrlData } = supabase.storage.from(SUPABASE_STORAGE_BUCKET).getPublicUrl(storagePath);
        finalVideoUrl = publicUrlData?.publicUrl;
        console.log(`[WORKER] SUCCESS: Video uploaded. Public URL: ${finalVideoUrl}`);
    } catch (e) {
        console.error(`[WORKER] UPLOAD ERROR for job ${scriptId}:`, e.message);
        throw e; 
    } finally {
        try { await fs.unlink(tempFilePath); } catch (e) { console.warn(`[WORKER] Clean up warning: File not found at ${tempFilePath}.`); }
    }
    return finalVideoUrl;
}

async function updateJobStatus(scriptId, status, progress_percentage, error_message = null, final_video_url = null) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
    
    const payload = { status, progress_percentage, error_message, final_video_url };
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
 * Creates a playable FFmpeg command for the correct duration with a logo overlay.
 */
function buildFFmpegCommand(job, scriptId) {
    const videoData = job[VIDEO_DATA_COLUMN_NAME] || {};
    let logoUrl = job[LOGO_VIDEO_URL_COLUMN] || FALLBACK_LOGO_URL;

    if (!logoUrl.startsWith('http')) {
        logoUrl = FALLBACK_LOGO_URL;
        console.warn(`[WORKER] Logo URL was invalid or missing for job ${scriptId}. Using fallback.`);
    }

    // Use total_duration from the JSON data, falling back to a minimum of 5s.
    const duration = videoData.total_duration && !isNaN(videoData.total_duration) && videoData.total_duration > 0 ? videoData.total_duration : 5; 
    const outputFileName = `output_${scriptId}.mp4`;
    const tempFilePath = path.join('/tmp', outputFileName);
    
    console.log(`[WORKER] Building FFmpeg Command for Job ${scriptId}. Duration: ${duration}s. Logo URL: ${logoUrl}`);
    
    const args = [
        // Input [0]: Blue background video stream
        '-f', 'lavfi',
        '-i', `color=c=blue:s=1280x720:d=${duration}`, 
        
        // Input [1]: Silent audio stream (Required for playable MP4)
        '-f', 'lavfi',
        '-i', `anullsrc=channel_layout=stereo:sample_rate=44100:d=${duration}`, 
        
        // Input [2]: Logo Video/Image
        '-i', logoUrl, 
        
        // Input [3]: Caption Image (Placeholder)
        '-i', CAPTION_IMAGE_URL, 
        
        // --- FILTER COMPLEX (Overlay the logo and the caption) ---
        // [0] (color) + [2] (logo) -> [v1] (logo at top left)
        // [v1] + [3] (caption) -> [v] (caption at bottom)
        '-filter_complex', '[0][2]overlay=x=10:y=10[v1]; [v1][3]overlay=x=0:y=H-h[v]', 
        
        // Map the final video stream [v] and the silent audio stream [1:a]
        '-map', '[v]', 
        '-map', '1:a', 
        
        // Output settings
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv444p',
        '-y', 
        tempFilePath 
    ];
    return { args, tempFilePath };
}

function executeFFmpeg(args, scriptId) {
    return new Promise((resolve, reject) => {
        // Estimate duration for logging
        const durationArg = args.find(arg => arg.includes('color=') && arg.includes('d='));
        let duration = 'unknown';
        if (durationArg) {
            const match = durationArg.match(/d=(\d+(\.\d+)?)/);
            if (match) duration = match[1];
        }

        console.log(`[WORKER] Executing FFmpeg for job ${scriptId}. Estimated run time: ~${duration} seconds.`);
        const ffmpeg = spawn('ffmpeg', args); 
        let stderr = '';
        
        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                console.log(`[WORKER] FFmpeg Job ${scriptId} completed successfully.`);
                resolve({ success: true });
            } else {
                reject(new Error(`FFmpeg exited with code ${code}. Error Output: ${stderr}`));
            }
        });
        
        ffmpeg.on('error', (err) => {
            reject(new Error(`[WORKER] Failed to start FFmpeg: ${err.message}`));
        });
    });
}

// =========================================================
// === MAIN WORKER LOOP (Polling for PENDING jobs) =========
// =========================================================

let isProcessingJob = false;

async function processJob(job) {
    if (isProcessingJob) return; 
    isProcessingJob = true;
    
    const scriptId = job.id;
    let tempFilePath = '';
    
    try {
        const videoData = job[VIDEO_DATA_COLUMN_NAME] || {}; 
        const duration = videoData.total_duration || 5;

        console.log(`[WORKER] Starting job ${scriptId}. Actual video duration: ${duration}s`);
        
        // 1. Update status to IN_PROGRESS
        await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 10);
        
        // 2. Build FFmpeg command
        const commandData = buildFFmpegCommand(job, scriptId); 
        tempFilePath = commandData.tempFilePath;

        await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 25);
        
        // 3. Execute FFmpeg
        await executeFFmpeg(commandData.args, scriptId); 
        
        await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 75);

        // 4. Upload result
        const finalVideoUrl = await uploadVideoToStorage(scriptId, tempFilePath);
        
        // 5. Final status update
        await updateJobStatus(scriptId, STATUS_COMPLETED, 100, null, finalVideoUrl);

    } catch (error) {
        console.error(`[WORKER] Job ${scriptId} failed:`, error);
        await updateJobStatus(scriptId, STATUS_FAILED, 0, error.message);
    } finally {
        isProcessingJob = false;
    }
}

async function fetchAndProcessJobs() {
    // Crucial check: Don't run DB queries if config is missing
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return; 
    if (isProcessingJob) return;

    // Fetch the single oldest PENDING job
    const { data: jobs, error } = await supabase
        .from(SUPABASE_TABLE_NAME)
        .select(`id, ${VIDEO_DATA_COLUMN_NAME}, ${LOGO_VIDEO_URL_COLUMN}, user_id, series_id`) 
        .eq('status', STATUS_PENDING) 
        .limit(1);

    if (error) {
        console.error('[WORKER] Error fetching jobs:', error.message);
        return;
    }

    if (jobs && jobs.length > 0) {
        console.log(`[WORKER] Found PENDING job ${jobs[0].id}. Initiating process.`);
        await processJob(jobs[0]); 
    }
}


// =========================================================
// === EXPRESS WEB SERVICE (API endpoints) =================
// =========================================================

const app = express();
app.use(express.json());

// --- /RENDER ENDPOINT (Queueing new jobs) ---
app.post('/render', async (req, res) => {
    // Fail immediately if Supabase credentials are not set
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return res.status(503).send({ error: 'Server misconfigured. Missing Supabase credentials.' });
    }

    const { videoData, scriptId, logoVideoUrl, userId, seriesId } = req.body; 
    
    if (!scriptId) return res.status(400).send({ error: 'Missing scriptId.' });

    const fullScriptText = videoData?.scenes
        ? videoData.scenes.map(scene => scene.description).join('\n---\n')
        : "Script data missing upon queueing.";
    
    const payload = { 
        id: scriptId,
        status: STATUS_PENDING, 
        progress_percentage: 0.0,
        // ... other payload fields
        
        // FIX: Use numeric defaults (0) for bigint/integer fields to prevent "invalid input syntax for type bigint: 'N/A'"
        [LOGO_VIDEO_URL_COLUMN]: logoVideoUrl || FALLBACK_LOGO_URL, 
        user_id: userId || 0, // FIXED: Numeric placeholder 0
        series_id: seriesId || 0, // FIXED: Numeric placeholder 0

        [VIDEO_DATA_COLUMN_NAME]: videoData || {}
    };
    
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
            const errorText = await response.text();
            console.error(`Supabase queue insert failed: ${response.status}`, errorText);
            return res.status(500).send({ error: 'Failed to queue job', details: errorText });
        }
        
        console.log(`Job ${scriptId} queued instantly. Background loop will process.`);
        res.status(202).send({ 
            success: true, 
            message: `FFmpeg job queued successfully for script ${scriptId}. Background processing started.` 
        });
    } catch (error) {
        console.error('Queue error:', error);
        res.status(500).send({ error: 'Internal server error' });
    }
});

// --- Health Check / Root Endpoint ---
app.get('/', (req, res) => res.send('Storyloom Dual-Purpose Web Service Ready.'));

// --- Start the server ---
app.listen(PORT, () => {
    console.log(`Web Service listening on port ${PORT}`);
    
    // --- START THE BACKGROUND POLLING LOOP ---
    if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
        setInterval(fetchAndProcessJobs, POLLING_INTERVAL_MS);
        console.log(`Background worker loop initialized. Checking for jobs every ${POLLING_INTERVAL_MS / 1000}s.`);
    } else {
        console.warn('Background worker disabled due to missing Supabase configuration.');
    }
});
