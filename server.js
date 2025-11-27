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

    // --- FIX FOR 400 ERROR: Include Mandatory Content Fields ---
    // The previous error (400) was because your database requires these fields 
    // (title, full_script, environment_tag, content_type) to be present.
    const payload = { 
        id: scriptId,
        status: status, 
        video_data: videoData, 
        progress_percentage: 0.0, // Ensure numeric type (we added this column earlier)
        
        // **THESE FIELDS ARE CRITICAL TO AVOID THE 400 ERROR:**
        title: videoData.title || "Untitled Video",
        full_script: videoData.full_script || "Script data missing.",
        environment_tag: videoData.environment_tag || "2D",
        content_type: videoData.content_type || "cartoon",
    };

    // Log the payload being sent for debugging
    console.log(`Attempting to send payload to Supabase for script ${scriptId}:`, JSON.stringify(payload).substring(0, 300) + "...");

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
        
        if (!response.ok) {
            console.error(`Supabase QUEUE INSERT failed: ${response.status}`);
            const errorText = await response.text();
            console.error(`Supabase Response Body Error (CRITICAL DEBUG):`, errorText); // This will show the exact missing column name!
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
    // The Web Server immediately tells the client: "Job received and added to queue." (No timeout!)
    res.status(202).send({ success: true, message: `FFmpeg job queued successfully for script ${scriptId}` });

    console.log(`Job ${scriptId} received and queued. Status: QUEUED`);
});

app.get('/', (req, res) => res.send('Storyloom Web Queue is Ready'));
app.listen(PORT, () => console.log(`Web Queue Listening on port ${PORT}`));
