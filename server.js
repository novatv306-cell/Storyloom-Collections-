/* server.js - The Quick Queue Router */

const express = require('express');

// --- Configuration from Environment Variables ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: Supabase credentials missing.");
}

/**
 * Updates or Inserts the job in the Supabase story_scripts table, setting status to QUEUED.
 */
async function updateJobStatus(scriptId, videoData, status) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;

    const payload = { 
        id: scriptId,
        status: status, 
        video_data: videoData,
        progress_percentage: 0 // Initialize progress to 0 for the worker
    };

    try {
        // We use UPSERT to ensure the record exists or is created/updated
        const response = await fetch(`${SUPABASE_URL}/rest/v1/story_scripts`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
                'Prefer': 'resolution=merge-duplicates' // UPSERT behavior
            },
            body: JSON.stringify(payload)
        });
        if (!response.ok) console.error(`Supabase QUEUE INSERT failed: ${response.status}`);
    } catch (e) {
        console.error(`Failed to send queue update:`, e);
    }
}

const app = express();
app.use(express.json());

app.post('/render', async (req, res) => {
    const { videoData, scriptId } = req.body; 

    if (!videoData || !scriptId) {
        return res.status(400).send({ error: 'Missing videoData or scriptId.' });
    }

    // --- STEP 1: QUEUE THE JOB ---
    await updateJobStatus(scriptId, videoData, 'QUEUED');

    // --- STEP 2: RESPOND IMMEDIATELY ---
    // The Web Server immediately tells the client: "Job received and added to queue."
    res.status(202).send({ success: true, message: `FFmpeg job queued successfully for script ${scriptId}` });

    console.log(`Job ${scriptId} received and queued. Status: QUEUED`);
});

app.get('/', (req, res) => res.send('Storyloom Web Queue is Ready'));
app.listen(PORT, () => console.log(`Web Queue Listening on port ${PORT}`));
