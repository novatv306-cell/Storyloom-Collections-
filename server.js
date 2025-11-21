const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Configuration from Environment Variables (Set on Render.com) ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: Supabase credentials missing. Cannot update status. Check Render.com environment variables.");
}


// Function to call back to Supabase and update job status
async function updateJobStatus(scriptId, status, outputUrl = null, errorMessage = null) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        return; 
    }

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
        if (!response.ok) {
            console.error(`Supabase PATCH failed: ${response.status} ${response.statusText}`);
        } else {
            console.log(`Updated script ${scriptId} to status: ${status}`);
        }
    } catch (e) {
        console.error(`Failed to send status update for ${scriptId}:`, e);
    }
}


// --- The Core FFmpeg Rendering Endpoint ---
const app = express();
app.use(express.json());

app.post('/render', async (req, res) => {
    const { 
        command, 
        scriptId, 
    } = req.body;

    if (!command || !scriptId) {
        return res.status(400).send({ error: 'Missing command or scriptId.' });
    }

    // 1. Acknowledge and immediately start the background process
    res.status(202).send({ success: true, message: `FFmpeg job started for script ${scriptId}` });

    // 2. Execute the FFmpeg command
    console.log(`Executing FFmpeg command for ${scriptId}: ${command}`);
    
    // Create a unique temporary output path
    const outputFilePath = path.join('/tmp', `video_${scriptId}.mp4`);
    const finalCommand = command.replace('output.mp4', outputFilePath); // Replace generic output with specific path

    // 3. Run the FFmpeg process (120 second timeout)
    exec(finalCommand, { timeout: 120000 }, async (error, stdout, stderr) => {
        if (error) {
            console.error(`FFmpeg ERROR for ${scriptId}. Log: ${stderr}`, error);
            await updateJobStatus(scriptId, 'RENDERING_FAILED', null, `FFmpeg Error: ${error.message}. Logs: ${stderr.substring(0, 200)}...`);
            return;
        }

        console.log(`FFmpeg job successful for ${scriptId}.`);
        
        // Hypothetical Success: Simulate the final upload URL 
        const finalUrl = `https://storage.supabase.com/final_videos/video_${scriptId}.mp4`; 
        
        // 4. Update the database on success
        await updateJobStatus(scriptId, 'RENDERING_COMPLETE', finalUrl);

        // 5. Clean up the temporary file
        fs.unlink(outputFilePath, (err) => {
            if (err) console.error(`Failed to delete temporary file ${outputFilePath}:`, err);
        });
    });
});

app.get('/', (req, res) => {
    res.send('Storyloom Render Engine is alive and waiting for POST requests on /render');
});

app.listen(PORT, () => {
    console.log(`Storyloom Render Engine listening on port ${PORT}`);
});
