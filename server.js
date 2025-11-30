// server.js - The Web Service (Fast Queueing Only)
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

// --- Configuration from Environment Variables ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; 
const PORT = process.env.PORT || 3000;

const SUPABASE_TABLE_NAME = 'story_script'; 
const VIDEO_DATA_COLUMN_NAME = 'script_data'; 
const STATUS_PENDING = 'PENDING'; 

// Initialize Supabase Client
const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY 
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) 
    : { storage: { from: () => ({ upload: () => Promise.reject(new Error('Supabase client not initialized')) }) } };

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("CRITICAL ERROR: Supabase credentials missing.");
}

const app = express();
app.use(express.json());

// --- /RENDER ENDPOINT (Queueing) ---
app.post('/render', async (req, res) => {
    const { videoData, scriptId } = req.body; 
    if (!videoData || !scriptId) return res.status(400).send({ error: 'Missing videoData or scriptId.' });

    // Safely extract the full script from the nested scenes array (Data Fix)
    const fullScriptText = videoData.scenes
        ? videoData.scenes.map(scene => scene.description).join('\n---\n')
        : "Script data missing.";
    
    // Corrected Data Mapping
    const payload = { 
        id: scriptId,
        status: STATUS_PENDING, 
        progress_percentage: 0.0,
        error_message: null,
        title: videoData.title || "Untitled Video",
        full_script: fullScriptText, 
        environment_tag: videoData.animation_style || "2D", 
        content_type: videoData.content_type || "cartoon",
        main_character_names: videoData.script_analysis?.mainCharacters || [] 
    };
    payload[VIDEO_DATA_COLUMN_NAME] = videoData;
    
    const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE_NAME}`;

    try {
        const response = await fetch(url, {
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
            console.error(`Supabase queue insert failed: ${response.status}`, await response.text());
            return res.status(500).send({ error: 'Failed to queue job' });
        }
        
        // This instantly returns success and prevents the web service from crashing.
        console.log(`Job ${scriptId} queued instantly. Worker will now take over.`);
        res.status(202).send({ 
            success: true, 
            message: `FFmpeg job queued successfully for script ${scriptId}. Worker processing soon.` 
        });
    } catch (error) {
        console.error('Queue error:', error);
        res.status(500).send({ error: 'Internal server error' });
    }
});

app.get('/', (req, res) => res.send('Storyloom Web Service Ready. Worker running independently.'));
app.listen(PORT, () => console.log(`Web Service listening on port ${PORT}`));
