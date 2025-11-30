// worker.js - The Worker Service (Background FFmpeg Processor)
const { spawn } = require('child_process'); 
const fs = require('fs/promises'); 
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

// --- Configuration from Environment Variables ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 

const SUPABASE_TABLE_NAME = 'story_script'; 
const SUPABASE_STORAGE_BUCKET = 'generated-content'; 
const VIDEO_DATA_COLUMN_NAME = 'script_data'; 
const POLLING_INTERVAL_MS = 5000; // Check for new jobs every 5 seconds

const STATUS_PENDING = 'PENDING'; 
const STATUS_IN_PROGRESS = 'PROCESSING_RENDER'; 
const STATUS_COMPLETED = 'RENDERING_COMPLETE'; 
const STATUS_FAILED = 'FAILED'; 

// Initialize Supabase Client
const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY 
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } }) 
    : { storage: { from: () => ({ upload: () => Promise.reject(new Error('Supabase client not initialized')) }) } };

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: Supabase credentials missing. Worker cannot function.");
    process.exit(1);
}

// --- Utility Functions (for the worker) ---

/**
 * Uploads the video file to Supabase Storage and cleans up the local file.
 */
async function uploadVideoToStorage(scriptId, tempFilePath) {
    const storagePath = `public/${scriptId}.mp4`;
    let finalVideoUrl = null;
    
    try {
        const stats = await fs.stat(tempFilePath);
        if (stats.size === 0) {
            throw new Error("Generated file size is zero. Not uploading.");
        }
        
        const videoBuffer = await fs.readFile(tempFilePath);
        
        const { error } = await supabase.storage
            .from(SUPABASE_STORAGE_BUCKET)
            .upload(storagePath, videoBuffer, {
                contentType: 'video/mp4',
                upsert: true,
            });

        if (error) {
            throw new Error(`Supabase upload failed: ${error.message}`);
        }

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
        throw e; 
    }
    
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
 * Builds the FFmpeg command for the video, using the dynamic duration.
 */
function buildFFmpegCommand(videoData) {
    const scriptId = videoData.id || uuidv4();
    const outputFileName = `output_${scriptId}.mp4`;
    const tempFilePath = path.join('/tmp', outputFileName);
    
    // Using the actual duration from the payload (e.g., 23s)
    const videoDuration = videoData.total_duration || 5; 
    
    const captionImageUrl = 'https://placehold.co/1280x100/000000/000000.png'; 
    
    console.log(`[WORKER] Generating COMMAND for Job ${scriptId} for full duration ${videoDuration}s.`);
    
    const args = [
        '-f', 'lavfi',
        '-i', `color=c=blue:s=1280x720:d=${videoDuration}`, 
        
        '-i', captionImageUrl, 
        
        '-filter_complex', '[0][1]overlay=x=0:y=H-h[v]', 
        '-map', '[v]', 
        
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv444p',
        '-y', 
        tempFilePath 
    ];
    
    return { args, tempFilePath };
}


/**
 * Executes the FFmpeg command in a child process.
 */
function executeFFmpeg(args, scriptId) {
    return new Promise((resolve, reject) => {
        console.log(`[WORKER] Executing FFmpeg for job ${scriptId}.`);
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


// --- Main Worker Logic ---

async function processJob(job) {
    const scriptId = job.id;
    let tempFilePath = '';
    
    console.log(`[WORKER] Starting job ${scriptId}. Total Duration: ${job.script_data.total_duration}s`);
    
    try {
        // 1. Set status to IN_PROGRESS
        await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 10);
        
        // 2. Build FFmpeg command arguments (using full duration)
        const commandData = buildFFmpegCommand(job.script_data);
        tempFilePath = commandData.tempFilePath;

        await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 25);

        // 3. Execute FFmpeg (This is the long running part)
        await executeFFmpeg(commandData.args, scriptId); 
        await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 75);

        // 4. Upload result
        const finalVideoUrl = await uploadVideoToStorage(scriptId, tempFilePath);
        await updateJobStatus(scriptId, STATUS_IN_PROGRESS, 90);

        // 5. Set final completion status
        await updateJobStatus(scriptId, STATUS_COMPLETED, 100, null, finalVideoUrl);

    } catch (error) {
        console.error(`[WORKER] Job ${scriptId} failed:`, error);
        await updateJobStatus(scriptId, STATUS_FAILED, 0, error.message);
    } finally {
        // Ensure cleanup runs
        if (tempFilePath) {
            try {
                // Ensure the file is deleted after processing/failing
                await fs.unlink(tempFilePath);
            } catch (e) {
                // Ignore cleanup error if file doesn't exist
            }
        }
    }
}

async function fetchAndProcessJobs() {
    console.log(`[WORKER] Checking for ${STATUS_PENDING} jobs...`);
    
    // Fetch one PENDING job
    const { data: jobs, error } = await supabase
        .from(SUPABASE_TABLE_NAME)
        .select(`id, ${VIDEO_DATA_COLUMN_NAME}`)
        .eq('status', STATUS_PENDING) 
        .limit(1);

    if (error) {
        console.error('[WORKER] Error fetching jobs:', error.message);
        return;
    }

    if (jobs && jobs.length > 0) {
        // We found a job, process it, then check again immediately
        await processJob(jobs[0]);
        // After success/failure, check for another job immediately
        fetchAndProcessJobs(); 
    } else {
        // No jobs found, schedule the next poll
        setTimeout(fetchAndProcessJobs, POLLING_INTERVAL_MS);
    }
}

console.log(`Storyloom Worker Service Starting. Polling interval: ${POLLING_INTERVAL_MS / 1000}s`);
fetchAndProcessJobs();
