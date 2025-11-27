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

    // This payload ensures all mandatory fields for your table are present
    const payload = { 
        id: scriptId,
        status: status, 
        video_data: videoData, // <--- MUST MATCH THE RENAMED COLUMN IN SUPABASE
        progress_percentage: 0.0, 
        
        // Mandatory fields from your row structure:
        title: videoData.title || "Untitled Video",
        full_script: videoData.full_script || "Script data missing.",
        environment_tag: videoData.environment_tag || "2D",
        content_type: videoData.content_type || "cartoon",
    };

    // Log the payload being sent for debugging
    console.log(`Attempting to send payload to Supabase for script ${scriptId}:`, JSON.stringify(payload).substring(0, 300) + "...");

    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/story_scripts`, {
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
            console.error(`Supabase QUEUE INSERT failed: ${response.status}`);
            const errorText = await response.text();
            console.error(`Supabase Response Body Error (CRITICAL DEBUG):`, errorText); 
            return;
        }
        
        console.log(`Supabase QUEUE INSERT successful. Job is queued for the Worker.`);

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
    res.status(202).send({ success: true, message: `FFmpeg job queued successfully for script ${scriptId}` });

    console.log(`Job ${scriptId} received and queued. Status: QUEUED`);
});

app.get('/', (req, res) => res.send('Storyloom Web Queue is Ready'));
app.listen(PORT, () => console.log(`Web Queue Listening on port ${PORT}`));
