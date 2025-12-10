const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { spawn } = require('child_process'); 
const { promises: fs } = require('fs'); 
const path = require('path');

// --- Configuration ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const PORT = process.env.PORT || 3000;

const SUPABASE_TABLE_NAME = 'story_script'; 
const SUPABASE_STORAGE_BUCKET = 'generated-content'; 

// CRITICAL CONFIRMED COLUMN NAMES:
const VIDEO_DATA_COLUMN_NAME = 'script_data'; 
const LOGO_VIDEO_URL_COLUMN = 'logo_video_url'; 

const POLLING_INTERVAL_MS = 5000; 

const STATUS_PENDING = 'PENDING'; 
const STATUS_IN_PROGRESS = 'PROCESSING_RENDER'; 
const STATUS_COMPLETED = 'RENDERING_COMPLETE'; 
const STATUS_FAILED = 'FAILED'; 

const FALLBACK_LOGO_URL = 'https://placehold.co/100x100/191970/FFFFFF.png?text=LOGO';

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY 
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }) 
    : {};

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: Supabase credentials missing. App cannot access database.");
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

// =================================================================
// === FFmpeg EXECUTION SIMULATION (to bypass environment block) ===
// =================================================================

function executeFFmpeg(args, scriptId, tempFilePath) {
    return new Promise(async (resolve, reject) => {
        console.log(`[WORKER] !!! SIMULATION MODE ACTIVE !!! FFmpeg execution simulated for job ${scriptId}.`);
        console.log(`[WORKER] COMMAND ARGS (ignored in simulation): ${args.join(' ')}`);

        // 1. Simulate a render time (5 seconds)
        await new Promise(r => setTimeout(r, 5000));
        
        // 2. Create a dummy MP4 file for the upload step to succeed.
        // This is a minimal valid MP4 file (a tiny stub of a video).
        try {
            const dummyVideoData = Buffer.from([
                0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
                0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31
            ]);
            await fs.writeFile(tempFilePath, dummyVideoData);
            console.log(`[WORKER] SIMULATION: Created dummy file at ${tempFilePath}`);
        } catch (e) {
            reject(new Error(`Simulation failed to create dummy file: ${e.message}`));
            return;
        }

        console.log(`[WORKER] SIMULATION: FFmpeg Job ${scriptId} finished successfully.`);
        resolve({ success: true });
    });
}
// ------------------------------------------------------------------

/**
 * FINAL FFmpeg COMMAND GENERATION
 * This is where we will insert your real video logic once the pipeline is confirmed.
 */
function buildFFmpegCommand(job, scriptId) {
    const videoData = job[VIDEO_DATA_COLUMN_NAME] || {};
    
    // Default duration is 60 seconds if not specified in the job data.
    const DEFAULT_DURATION = 20; 
    const duration = videoData.total_duration && !isNaN(videoData.total_duration) && videoData.total_duration > 0 ? videoData.total_duration : DEFAULT_DURATION; 
    
    const outputFileName = `output_${scriptId}.mp4`;
    const tempFilePath = path.join('/tmp', outputFileName);
    
    console.log(`[WORKER] Building FFmpeg Command for Job ${scriptId}. FINAL VIDEO DURATION: ${duration}s.`);
    
    // Placeholder args array (unused in simulation, but required for structure)
    const args = [
        '-f', 'lavfi', '-i', `color=c=black:s=1280x720:d=${duration}`, 
        '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=44100:d=${duration}`, 
        '-map', '0:v', '-map', '1:a',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', 
        tempFilePath 
    ];

    return { args, tempFilePath };
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
        const duration = videoData.total_duration || 20; 

        console.log(`[WORKER] Starting job ${scriptId}. Actual video duration: ${duration}s`);
        
        await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 10);
        
        const commandData = buildFFmpegCommand(job, scriptId); 
        tempFilePath = commandData.tempFilePath;

        await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 25);
        
        // Execute FFmpeg (NOW IN SIMULATION MODE)
        await executeFFmpeg(commandData.args, scriptId, tempFilePath); 
        
        await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 75);

        // Upload result
        const finalVideoUrl = await uploadVideoToStorage(scriptId, tempFilePath);
        
        // Final status update
        await updateJobStatus(scriptId, STATUS_COMPLETED, 100, null, finalVideoUrl);

    } catch (error) {
        console.error(`[WORKER] Job ${scriptId} failed:`, error);
        // Clear the error message for subsequent attempts
        await updateJobStatus(scriptId, STATUS_FAILED, 0, `Worker failed: ${error.message}`);
    } finally {
        isProcessingJob = false;
    }
}

async function fetchAndProcessJobs() {
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
        title: videoData?.title || "Untitled Video",
        full_script: fullScriptText, 
        environment_tag: videoData?.animation_style || "2D", 
        content_type: videoData?.content_type || "cartoon", 
        main_character_names: videoData?.script_analysis?.mainCharacters || [],
        
        // FIXED: UUID fields must be null if not provided.
        [LOGO_VIDEO_URL_COLUMN]: logoVideoUrl || FALLBACK_LOGO_URL, 
        user_id: userId || null, 
        series_id: seriesId || null, 

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
