const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { spawn } = require('child_process'); 
const fs = require('fs/promises'); 
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// --- Configuration ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const PORT = process.env.PORT || 3000;

const SUPABASE_TABLE_NAME = 'story_script'; 
const SUPABASE_STORAGE_BUCKET = 'generated-content'; 
const VIDEO_DATA_COLUMN_NAME = 'script_data'; 
const POLLING_INTERVAL_MS = 5000; // Check for new jobs every 5 seconds

const STATUS_PENDING = 'PENDING'; 
const STATUS_IN_PROGRESS = 'PROCESSING_RENDER'; 
const STATUS_COMPLETED = 'RENDERING_COMPLETE'; 
const STATUS_FAILED = 'FAILED'; 

// Placeholder URLs for proof of concept
// In a real app, these would be dynamic based on videoData or saved in Supabase Storage.
const LOGO_URL = 'https://placehold.co/150x150/191970/FFFFFF.png?text=LOGO';
const CAPTION_IMAGE_URL = 'https://placehold.co/1280x100/000000/FFFFFF.png?text=Your+Dynamic+Caption+Here'; 

// Initialize Supabase Client
const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY 
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }) 
    : { storage: { from: () => ({ upload: () => Promise.reject(new Error('Supabase client not initialized')) }) } };

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: Supabase credentials missing. App cannot function.");
    process.exit(1);
}

// =========================================================
// === WORKER UTILITIES ====================================
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

function buildFFmpegCommand(videoData) {
    const scriptId = videoData.id || uuidv4();
    const outputFileName = `output_${scriptId}.mp4`;
    const tempFilePath = path.join('/tmp', outputFileName);
    
    // Use a default of 5 seconds if duration is corrupt or missing (prevents crash)
    const videoDuration = videoData.total_duration || 5; 
    
    console.log(`[WORKER] Generating COMMAND for Job ${scriptId} for full duration ${videoDuration}s (Content Type: ${videoData.content_type}).`);
    
    const args = [
        '-f', 'lavfi',
        '-i', `color=c=blue:s=1280x720:d=${videoDuration}`, // [0] Background Video/Color
        '-i', LOGO_URL, // [1] Logo Image (The one you want at the beginning)
        '-i', CAPTION_IMAGE_URL, // [2] Caption Image (The one you want at the bottom)
        
        // Filter Complex: 
        // 1. Overlay the Logo [1] onto the Background [0] -> Output stream [v1]
        //    (Logo placed at top-left corner, x=10, y=10)
        // 2. Overlay the Caption [2] onto stream [v1] -> Output stream [v]
        //    (Caption placed at the bottom, y=H-h)
        '-filter_complex', '[0][1]overlay=x=10:y=10[v1]; [v1][2]overlay=x=0:y=H-h[v]', 
        
        '-map', '[v]', 
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv444p',
        '-y', 
        tempFilePath 
    ];
    return { args, tempFilePath };
}

function executeFFmpeg(args, scriptId) {
    return new Promise((resolve, reject) => {
        const durationArg = args.find(arg => arg.startsWith('color=c='));
        const durationMatch = durationArg ? durationArg.match(/d=(\d+)/) : null;
        const duration = durationMatch ? durationMatch[1] : 'unknown';

        console.log(`[WORKER] Executing FFmpeg for job ${scriptId}. This will take up to ~${duration} seconds.`);
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
// === MAIN WORKER LOOP ====================================
// =========================================================

let isProcessingJob = false;

async function processJob(job) {
    if (isProcessingJob) return; 
    isProcessingJob = true;
    
    const scriptId = job.id;
    let tempFilePath = '';
    
    // --- CRITICAL DEFENSIVE CHECK (Handles corrupt or missing duration) ---
    if (!job.script_data) {
        // We can't proceed without script_data, so we must fail it out.
        const errorMsg = `Job ${scriptId} data is missing. Marking as FAILED.`;
        console.error(`[WORKER] Job ${scriptId} failed:`, errorMsg);
        await updateJobStatus(scriptId, STATUS_FAILED, 0, errorMsg);
        isProcessingJob = false;
        return;
    }
    // ------------------------------------------

    try {
        // Use the total_duration, or default to 5 seconds to prevent crash
        const duration = job.script_data.total_duration || 5; 
        console.log(`[WORKER] Starting job ${scriptId}. Total Duration: ${duration}s`);
        
        await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 10);
        
        const commandData = buildFFmpegCommand(job.script_data);
        tempFilePath = commandData.tempFilePath;

        await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 25);
        
        // --- CRITICAL LONG-RUNNING STEP ---
        await executeFFmpeg(commandData.args, scriptId); 
        // ----------------------------------
        
        await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 75);

        const finalVideoUrl = await uploadVideoToStorage(scriptId, tempFilePath);
        
        // The worker updates the status *only*. The client is responsible for reading the 
        // 'content_type' field and displaying the correct tag on its UI.
        await updateJobStatus(scriptId, STATUS_COMPLETED, 100, null, finalVideoUrl);

    } catch (error) {
        console.error(`[WORKER] Job ${scriptId} failed:`, error);
        await updateJobStatus(scriptId, STATUS_FAILED, 0, error.message);
    } finally {
        isProcessingJob = false;
    }
}

async function fetchAndProcessJobs() {
    if (isProcessingJob) {
        console.log("[WORKER] Processor busy. Skipping check.");
        return;
    }
    
    const { data: jobs, error } = await supabase
        .from(SUPABASE_TABLE_NAME)
        .select(`id, ${VIDEO_DATA_COLUMN_NAME}, content_type`)
        .eq('status', STATUS_PENDING) 
        .limit(1);

    if (error) {
        console.error('[WORKER] Error fetching jobs:', error.message);
        return;
    }

    if (jobs && jobs.length > 0) {
        console.log(`[WORKER] Found PENDING job ${jobs[0].id} (Type: ${jobs[0].content_type}). Initiating process.`);
        await processJob(jobs[0]); 
    }
}


// =========================================================
// === EXPRESS WEB SERVICE (API) ===========================
// =========================================================

const app = express();
app.use(express.json());

// --- /RENDER ENDPOINT (Queueing) ---
app.post('/render', async (req, res) => {
    const { videoData, scriptId } = req.body; 
    if (!videoData || !scriptId) return res.status(400).send({ error: 'Missing videoData or scriptId.' });

    const fullScriptText = videoData.scenes
        ? videoData.scenes.map(scene => scene.description).join('\n---\n')
        : "Script data missing.";
    
    const payload = { 
        id: scriptId,
        status: STATUS_PENDING, 
        progress_percentage: 0.0,
        error_message: null,
        title: videoData.title || "Untitled Video",
        full_script: fullScriptText, 
        environment_tag: videoData.animation_style || "2D", 
        // Crucial for the Live Action/Cartoon distinction
        content_type: videoData.content_type || "cartoon", 
        main_character_names: videoData.script_analysis?.mainCharacters || [] 
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

app.get('/', (req, res) => res.send('Storyloom Dual-Purpose Web Service Ready.'));
app.listen(PORT, () => {
    console.log(`Web Service listening on port ${PORT}`);
    
    // --- CRITICAL: START THE BACKGROUND POLLING LOOP ---
    setInterval(fetchAndProcessJobs, POLLING_INTERVAL_MS);
    console.log(`Background worker loop initialized. Checking for jobs every ${POLLING_INTERVAL_MS / 1000}s.`);
});
