const express = require('express');

// --- Configuration from Environment Variables ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const PORT = process.env.PORT || 3000;

// *******************************************************************
// *** FINAL CONFIRMED CONFIGURATION (NO MORE NAME CHANGES NEEDED) ***
// *******************************************************************

// 1. Table Name (The collection of scripts)
const SUPABASE_TABLE_NAME = 'story_script'; 

// 2. Column Name (The JSON data field - RENAMED in Supabase to 'script_data')
const VIDEO_DATA_COLUMN_NAME = 'script_data'; 

// *******************************************************************

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: Supabase credentials missing.");
}

/**
 * Updates or Inserts the job in the Supabase table, setting status to QUEUED.
 */
async function updateJobStatus(scriptId, videoData, status) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;

    // Build the payload dynamically using the correct column name
    const payload = { 
        id: scriptId,
        status: status, 
        progress_percentage: 0.0,
        
        // Mandatory fields required by the database structure:
        title: videoData.title || "Untitled Video",
        full_script: videoData.full_script || "Script data missing.",
        environment_tag: videoData.environment_tag || "2D",
        content_type: videoData.content_type || "cartoon",
        
        // *** FINAL FIX: Adding the required 'main_character_names' array ***
        main_character_names: videoData.main_character_names || [], // Must be an array
    };
    
    // Dynamically assign the video data to the column name ('script_data')
    payload[VIDEO_DATA_COLUMN_NAME] = videoData;

    console.log(`Attempting to send payload to Supabase table ${SUPABASE_TABLE_NAME} for script ${scriptId}...`);

    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE_NAME}`, {
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
