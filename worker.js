/* worker.js - The Long-Running FFmpeg Processor */

const { spawn } = require('child_process'); 
const fs = require('fs');
const path = require('path');
const { buildFFmpegCommand } = require('./ffmpeg-builder'); 

// --- Configuration ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const POLLING_INTERVAL = 5000; // Worker checks for new jobs every 5 seconds
const PROGRESS_UPDATE_INTERVAL = 10000; // Update Supabase with progress every 10 seconds

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: Supabase credentials missing. Worker cannot run.");
    process.exit(1);
}

/**
 * Converts HH:MM:SS.ms string to total seconds.
 */
function convertTimeToSeconds(timeStr) {
    const parts = timeStr.split(/[:\.]/).map(parseFloat);
    if (parts.length < 4) return 0;
    // (hours * 3600) + (minutes * 60) + seconds + (milliseconds / 1000)
    return (parts[0] * 3600) + (parts[1] * 60) + parts[2] + (parts[3] / 100);
}

/**
 * Calculates the total expected duration of the video.
 */
function getTotalDuration(videoData) {
    // Sums duration of all scenes, plus logo, plus fixed 5s credits
    const sceneDuration = videoData.scenes.reduce((sum, scene) => sum + (scene.duration || 5), 0);
    const logoDuration = videoData.logo_video?.duration || 0;
    const creditsDuration = 5; 
    return logoDuration + sceneDuration + creditsDuration;
}

/**
 * Updates the job status and progress in the Supabase story_scripts table.
 */
async function updateJobStatus(scriptId, status, progress = null, outputUrl = null, errorMessage = null) {
    const payload = { 
        status: status, 
        progress_percentage: progress, // New progress column
        final_video_url: outputUrl, 
        error_message: errorMessage 
    };

    // Filter out null values for patch, except progress, which must be a number
    Object.keys(payload).forEach(key => payload[key] === null && key !== 'progress_percentage' && delete payload[key]);

    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/story_scripts?id=eq.${scriptId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
            },
            body: JSON.stringify(payload)
        });
        if (!response.ok) console.error(`Supabase Status PATCH failed: ${response.status}`);
    } catch (e) {
        console.error(`Failed to send status update:`, e);
    }
}

/**
 * Executes the FFmpeg rendering process using spawn to monitor progress.
 */
function runFFmpegJob(scriptId, videoData, totalDuration) {
    return new Promise((resolve, reject) => {
        const outputFilePath = path.join('/tmp', `video_${scriptId}.mp4`);
        let executionCommand;

        try {
            const rawCommand = buildFFmpegCommand(videoData); 
            executionCommand = rawCommand.replace('output.mp4', outputFilePath); 
        } catch (e) {
            return reject(new Error(`Command build failed: ${e.message}`));
        }

        console.log(`\n--- STARTING JOB ${scriptId} (Duration: ${totalDuration}s) ---\n`);

        // Split the command string into the command and its arguments
        const [cmd, ...args] = executionCommand.split(' ');
        
        const ffmpegProcess = spawn(cmd, args, { 
            shell: '/bin/sh', 
            env: process.env,
            detached: true 
        });

        let currentRenderTimeSeconds = 0;
        const timeRegex = /time=(\d{2}:\d{2}:\d{2}\.\d{2})/i;
        let lastReportedProgress = -1; 

        // Set up the interval timer to update Supabase frequently
        const progressReporter = setInterval(() => {
            const currentProgress = Math.min(100, Math.floor((currentRenderTimeSeconds / totalDuration) * 100));
            // Only update if progress has changed significantly
            if (currentProgress > lastReportedProgress + 1 || currentProgress === 0) {
                updateJobStatus(scriptId, 'IN_PROGRESS', currentProgress);
                lastReportedProgress = currentProgress;
                console.log(`Job ${scriptId} Progress: ${currentProgress}%`);
            }
        }, PROGRESS_UPDATE_INTERVAL);


        // FFmpeg writes progress logs to stderr
        ffmpegProcess.stderr.on('data', (data) => {
            const match = data.toString().match(timeRegex);
            if (match) {
                const timeString = match[1]; 
                currentRenderTimeSeconds = convertTimeToSeconds(timeString);
            }
        });

        ffmpegProcess.on('close', (code) => {
            clearInterval(progressReporter); // Stop reporting interval
            if (code === 0) {
                // Success
                resolve(outputFilePath);
            } else {
                // Failure or early exit
                let errorMessage = `FFmpeg exited with code ${code}.`;
                if (code === null) errorMessage = 'FFmpeg process was terminated unexpectedly (e.g., killed by OS or host timeout).';
                reject(new Error(errorMessage));
            }
        });

        ffmpegProcess.on('error', (err) => {
            clearInterval(progressReporter);
            reject(new Error(`FFmpeg process failed to start: ${err.message}`));
        });
    });
}

/**
 * Main worker loop: fetches a pending job and processes it.
 */
async function workerLoop() {
    try {
        // 1. Fetch one pending job from the story_scripts table where status is QUEUED
        const response = await fetch(
            `${SUPABASE_URL}/rest/v1/story_scripts?select=id,video_data&status=eq.QUEUED&limit=1`,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_SERVICE_KEY,
                    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
                }
            }
        );
        
        if (!response.ok) {
            console.error(`Supabase fetch failed: ${response.status}`);
            return;
        }

        const jobs = await response.json();

        if (jobs.length === 0) {
            // console.log("No new jobs found. Sleeping.");
            return;
        }

        const job = jobs[0];
        const scriptId = job.id;
        const videoData = job.video_data;
        const totalDuration = getTotalDuration(videoData);


        // 2. Mark the job as IN_PROGRESS and reset progress to 0
        await updateJobStatus(scriptId, 'IN_PROGRESS', 0);
        console.log(`Picked up job: ${scriptId}. Starting render...`);

        // 3. Run the FFmpeg Job
        let outputFilePath = null;
        try {
            outputFilePath = await runFFmpegJob(scriptId, videoData, totalDuration);

            // 4. On Success: Update status, set progress to 100%
            const finalUrl = `${SUPABASE_URL}/storage/v1/object/public/final_videos/video_${scriptId}.mp4`; 
            await updateJobStatus(scriptId, 'RENDERING_COMPLETE', 100, finalUrl);
            console.log(`Job ${scriptId} completed successfully.`);

        } catch (error) {
            // 5. On Failure: Update status with error message, retain progress if possible
            await updateJobStatus(scriptId, 'RENDERING_FAILED', null, null, error.message);
            console.error(`Job ${scriptId} failed: ${error.message}`);
        }
        
        // 6. Cleanup (Placeholder for Supabase Storage upload)
        if (outputFilePath && fs.existsSync(outputFilePath)) {
             // File would be uploaded and deleted here in a real app.
        }


    } catch (e) {
        console.error(`Worker failed during loop execution:`, e);
    } finally {
        // 7. Loop: Schedule the next check
        setTimeout(workerLoop, POLLING_INTERVAL);
    }
}

console.log("Storyloom Worker Service starting...");
workerLoop();
