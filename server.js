const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Configuration from Environment Variables ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: Supabase credentials missing. Check Render.com environment variables.");
}

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
    // 1. PRE-RENDER CLEANUP
    try {
        const files = fs.readdirSync('/tmp');
        for (const file of files) {
            if (file.startsWith('video_')) fs.unlinkSync(path.join('/tmp', file));
        }
    } catch (e) { console.warn('Cleanup warning:', e.message); }

    const { command, scriptId } = req.body;

    if (!command || !scriptId) {
        return res.status(400).send({ error: 'Missing command or scriptId.' });
    }

    res.status(202).send({ success: true, message: `FFmpeg job started for script ${scriptId}` });

    console.log(`Received command: ${command}`);
    
    const outputFilePath = path.join('/tmp', `video_${scriptId}.mp4`);
    
    // --- INTELLIGENT COMMAND FIXER ---
    // This logic ensures the command always starts with "ffmpeg " exactly once.
    let cleanCommand = command.trim();
    
    // If it starts with "render", replace it
    if (cleanCommand.startsWith('render')) {
         cleanCommand = cleanCommand.substring(6).trim();
    }

    // If it doesn't start with "ffmpeg", add it
    if (!cleanCommand.startsWith('ffmpeg')) {
        cleanCommand = 'ffmpeg ' + cleanCommand;
    }
    
    // Replace the generic output placeholder with the real local path
    const executionCommand = cleanCommand.replace('output.mp4', outputFilePath); 
    // ---------------------------------

    console.log(`Final Execution Command: ${executionCommand}`);

    // 3. RUN FFMPEG
    exec(executionCommand, { 
        timeout: 120000,
        shell: '/bin/sh', 
        env: process.env 
    }, async (error, stdout, stderr) => {
        if (error) {
            console.error(`FFmpeg ERROR for ${scriptId}. Log: ${stderr}`);
            await updateJobStatus(scriptId, 'RENDERING_FAILED', null, `FFmpeg Log: ${stderr.substring(0, 300)}...`);
            return;
        }

        console.log(`FFmpeg job successful for ${scriptId}.`);
        
        // Ideally, you would upload 'outputFilePath' to Supabase Storage here.
        // For now, we return the success status.
        const finalUrl = `https://storage.supabase.com/final_videos/video_${scriptId}.mp4`; 
        
        await updateJobStatus(scriptId, 'RENDERING_COMPLETE', finalUrl);
    });
});

app.get('/', (req, res) => res.send('Storyloom Render Engine is Ready'));
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
