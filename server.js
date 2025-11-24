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
        // Log the failure to Supabase so you can see it in the app logs
        await updateJobStatus(scriptId || 'UNKNOWN', 'RENDERING_FAILED', null, "Render Server received empty command or missing script ID.");
        return res.status(400).send({ error: 'Missing command or scriptId.' });
    }

    res.status(202).send({ success: true, message: `FFmpeg job started for script ${scriptId}` });

    console.log(`Received RAW command: ${command}`);
    
    const outputFilePath = path.join('/tmp', `video_${scriptId}.mp4`);
    
    // --- INTELLIGENT COMMAND FIXER (for 'render' vs 'ffmpeg' ambiguity) ---
    let cleanCommand = command.trim();
    
    // 1. Remove the word 'render' if it was accidentally prepended by the Edge Function
    if (cleanCommand.startsWith('render')) {
         cleanCommand = cleanCommand.substring(6).trim();
    }

    // 2. Ensure the command starts with 'ffmpeg' exactly once
    if (!cleanCommand.startsWith('ffmpeg')) {
        cleanCommand = 'ffmpeg ' + cleanCommand;
    }
    
    // 3. Replace the generic output placeholder with the real local path
    const executionCommand = cleanCommand.replace('output.mp4', outputFilePath); 
    // ----------------------------------------------------------------------

    // CRITICAL: Log the final command before running it.
    console.log(`\n\nFINAL EXECUTION COMMAND BEING RUN:\n==> ${executionCommand}\n\n`);

    // 4. RUN FFMPEG
    exec(executionCommand, { 
        timeout: 120000,
        shell: '/bin/sh', 
        env: process.env 
    }, async (error, stdout, stderr) => {
        if (error) {
            // Log the full command and the FFmpeg error output
            console.error(`FFmpeg ERROR for ${scriptId}. Command: ${executionCommand}`);
            console.error(`FFmpeg STDOUT (Non-error output):\n${stdout}`);
            console.error(`FFmpeg STDERR (Error output):\n${stderr}`);

            await updateJobStatus(scriptId, 'RENDERING_FAILED', null, `FFmpeg Failed. Command: ${executionCommand.substring(0, 50)}... Log: ${stderr.substring(0, 300)}...`);
            return;
        }

        console.log(`FFmpeg job successful for ${scriptId}.`);
        
        // This is a placeholder for the actual upload logic
        const finalUrl = `https://storage.supabase.com/final_videos/video_${scriptId}.mp4`; 
        
        await updateJobStatus(scriptId, 'RENDERING_COMPLETE', finalUrl);
    });
});

app.get('/', (req, res) => res.send('Storyloom Render Engine is Ready'));
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
