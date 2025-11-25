const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
// This line REQUIRES the ffmpeg-builder.js file to be present!
const { buildFFmpegCommand } = require('./ffmpeg-builder'); 

// --- Configuration from Environment Variables ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: Supabase credentials missing. Check Render.com environment variables.");
}

/**
 * Updates the job status in the Supabase story_scripts table.
 */
async function updateJobStatus(scriptId, status, outputUrl = null, errorMessage = null) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;

    const payload = { 
        status: status, 
        final_video_url: outputUrl, 
        error_message: errorMessage 
    };

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
        if (!response.ok) console.error(`Supabase PATCH failed: ${response.status}`);
    } catch (e) {
        console.error(`Failed to send status update:`, e);
    }
}

const app = express();
app.use(express.json());

app.post('/render', async (req, res) => {
    // 1. PRE-RENDER CLEANUP: Clear /tmp directory of old files
    try {
        const files = fs.readdirSync('/tmp');
        for (const file of files) {
            if (file.startsWith('video_')) fs.unlinkSync(path.join('/tmp', file)); 
        }
    } catch (e) { console.warn('Cleanup warning:', e.message); }

    const { videoData, scriptId } = req.body; 

    if (!videoData || !scriptId) {
        await updateJobStatus(scriptId || 'UNKNOWN', 'RENDERING_FAILED', null, "Render Server received empty videoData or missing script ID.");
        return res.status(400).send({ error: 'Missing videoData or scriptId.' });
    }

    res.status(202).send({ success: true, message: `FFmpeg job started for script ${scriptId}` });

    const outputFilePath = path.join('/tmp', `video_${scriptId}.mp4`);

    // --- STEP 2: BUILD THE FFmpeg COMMAND ---
    let executionCommand;
    try {
        const rawCommand = buildFFmpegCommand(videoData); 
        executionCommand = rawCommand.replace('output.mp4', outputFilePath); 

    } catch (e) {
        console.error(`COMMAND BUILD ERROR for ${scriptId}:`, e);
        await updateJobStatus(scriptId, 'RENDERING_FAILED', null, `Command build failed: ${e.message}`);
        return;
    }

    console.log(`\n\nFINAL EXECUTION COMMAND BEING RUN:\n==> ${executionCommand}\n\n`);

    // --- STEP 3: RUN FFMPEG ---
    exec(executionCommand, { 
        timeout: 240000, 
        shell: '/bin/sh', 
        env: process.env 
    }, async (error, stdout, stderr) => {
        if (error) {
            console.error(`FFmpeg ERROR for ${scriptId}. Command: ${executionCommand}`);
            console.error(`FFmpeg STDOUT (Non-error output):\n${stdout}`);
            console.error(`FFmpeg STDERR (Error output):\n${stderr}`);

            await updateJobStatus(scriptId, 'RENDERING_FAILED', null, `FFmpeg Failed. Command: ${executionCommand.substring(0, 50)}... Log: ${stderr.substring(0, 300)}...`);
            return;
        }

        console.log(`FFmpeg job successful for ${scriptId}.`);
        
        // Placeholder for real upload logic
        const finalUrl = `${SUPABASE_URL}/storage/v1/object/public/final_videos/video_${scriptId}.mp4`; 
        
        await updateJobStatus(scriptId, 'RENDERING_COMPLETE', finalUrl);
    });
});

app.get('/', (req, res) => res.send('Storyloom Render Engine is Ready'));
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
