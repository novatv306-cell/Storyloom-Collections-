/**
 * @typedef {Object} VideoData
 * @property {number} id
 * @property {Array<Object>} scenes
 * @property {Array<Object>} environments
 * @property {Array<Object>} characters
 * @property {Object} background_music
 * @property {Object} logo_video
 * @property {Object} credits
 */

/**
 * Builds the complete FFmpeg command string by parsing the complex videoData object.
 * This is the 'Heavy Server' logic that translates JSON into FFmpeg's filter graph syntax.
 *
 * NOTE: All file paths are assumed to be public URLs accessible by FFmpeg.
 *
 * @param {VideoData} videoData
 * @returns {string} The complete FFmpeg command.
 */
function buildFFmpegCommand(videoData) {
  const { id, scenes, environments, characters, background_music, logo_video, credits } = videoData;

  let command = 'ffmpeg -y'; // -y forces overwrite without prompt
  const inputs = [];
  const filterComplex = [];
  const sceneSegments = [];

  // Tracks the index of the next input file (e.g., [0], [1], [2]...)
  let inputIndex = 0;
  let logoInputIndex = -1;
  let musicInputIndex = -1;

  // --- Step 1: Add Global Inputs ---

  // Add logo video at input 0 if available
  if (logo_video?.url) {
    inputs.push(`-i "${logo_video.url}"`);
    logoInputIndex = inputIndex++;
  }

  // Add background music
  if (background_music?.url) {
    inputs.push(`-i "${background_music.url}"`);
    musicInputIndex = inputIndex++;
  }

  // --- Step 2: Process Each Scene ---
  scenes.forEach((scene, sceneIdx) => {
    // Default duration if not specified
    const sceneDuration = scene.duration || 5;

    // Find environment based on scene setting
    const environment = environments.find(e =>
      scene.setting?.toLowerCase().includes(e.name.toLowerCase())
    ) || environments[0]; // Fallback to first environment

    // Add environment image as input
    let envInputIndex = -1;
    if (environment?.image_url) {
      // Inputs are set to loop for the scene duration
      inputs.push(`-loop 1 -t ${sceneDuration} -i "${environment.image_url}"`);
      envInputIndex = inputIndex++;
    } else {
      // Fallback: create black background
      filterComplex.push(`color=c=black:s=1920x1080:d=${sceneDuration}[bg${sceneIdx}]`);
    }

    // Add character images for this scene
    const sceneCharacterInputs = [];
    for (const charName of scene.characters || []) {
      const character = characters.find(c => c.name === charName);
      if (character?.transparent_image_url) {
        inputs.push(`-loop 1 -t ${sceneDuration} -i "${character.transparent_image_url}"`);
        sceneCharacterInputs.push({
          name: charName,
          inputIndex: inputIndex++,
          character: character
        });
      }
    }

    // Add dialogue audio files for this scene
    const dialogueAudioInputs = [];
    let sceneAudioDuration = 0;
    for (const dialogue of scene.dialogue || []) {
      if (dialogue.audio_url) {
        inputs.push(`-i "${dialogue.audio_url}"`);
        dialogueAudioInputs.push({
          character: dialogue.character,
          text: dialogue.text,
          inputIndex: inputIndex++,
          duration: dialogue.duration || 3,
          startTime: sceneAudioDuration
        });
        sceneAudioDuration += dialogue.duration || 3;
      }
    }

    // --- Build filter for this scene ---
    let currentOverlay = '';

    // Start with environment background
    if (envInputIndex >= 0) {
      // Scale environment image to fit 1920x1080
      filterComplex.push(
        `[${envInputIndex}:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080[bg${sceneIdx}]`
      );
      currentOverlay = `bg${sceneIdx}`;
    } else {
      currentOverlay = `bg${sceneIdx}`; // If fallback color was used
    }

    // Overlay characters on background
    sceneCharacterInputs.forEach((charInput, charIdx) => {
      const xPos = 300 + (charIdx * 400); // Spread characters horizontally
      const yPos = 400; // Vertical position
      const overlayName = `scene${sceneIdx}_char${charIdx}_overlay`;

      // Scale character and overlay
      filterComplex.push(
        `[${charInput.inputIndex}:v]scale=400:-1[char${sceneIdx}_${charIdx}_scaled]`
      );
      filterComplex.push(
        `[${currentOverlay}][char${sceneIdx}_${charIdx}_scaled]overlay=${xPos}:${yPos}[${overlayName}]`
      );
      currentOverlay = overlayName;
    });

    // Add scene text overlay (scene description or action)
    if (scene.description) {
      const textOverlayName = `scene${sceneIdx}_text_overlay`;
      // Escape single quotes for FFmpeg's drawtext
      const escapedText = scene.description.replace(/'/g, "'\\''").substring(0, 100);
      filterComplex.push(
        `[${currentOverlay}]drawtext=text='${escapedText}':fontcolor=white:fontsize=24:x=(w-text_w)/2:y=50:box=1:boxcolor=black@0.5:boxborderw=5[${textOverlayName}]`
      );
      currentOverlay = textOverlayName;
    }

    // Trim scene video to exact duration and set PTS
    filterComplex.push(
      `[${currentOverlay}]trim=duration=${sceneDuration},setpts=PTS-STARTPTS[scene${sceneIdx}_video]`
    );

    // Mix dialogue audio for this scene
    if (dialogueAudioInputs.length > 0) {
      const audioMixInputs = dialogueAudioInputs.map(d => `[${d.inputIndex}:a]`).join('');
      // Concatenate dialogue audio tracks
      filterComplex.push(
        `${audioMixInputs}concat=n=${dialogueAudioInputs.length}:v=0:a=1[scene${sceneIdx}_audio]`
      );
      sceneSegments.push({
        video: `scene${sceneIdx}_video`,
        audio: `scene${sceneIdx}_audio`,
        duration: sceneDuration
      });
    } else {
      // Silent audio for this scene if no dialogue
      filterComplex.push(
        `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${sceneDuration}[scene${sceneIdx}_audio]`
      );
      sceneSegments.push({
        video: `scene${sceneIdx}_video`,
        audio: `scene${sceneIdx}_audio`,
        duration: sceneDuration
      });
    }
  });

  // --- Step 3: Concatenate all scenes ---
  const concatVideoInputs = sceneSegments.map(s => `[${s.video}]`).join('');
  const concatAudioInputs = sceneSegments.map(s => `[${s.audio}]`).join('');

  filterComplex.push(
    `${concatVideoInputs}concat=n=${sceneSegments.length}:v=1:a=0[main_video_temp]`
  );
  filterComplex.push(
    `${concatAudioInputs}concat=n=${sceneSegments.length}:v=0:a=1[main_audio_temp]`
  );

  // --- Step 4: Add Credits at the End ---
  const creditsDuration = 5;
  const creditsText = `Directed by ${credits.director}\\nAnimated by ${credits.animator}`; // \n works in drawtext
  filterComplex.push(
    `color=c=black:s=1920x1080:d=${creditsDuration}[credits_bg]`
  );
  filterComplex.push(
    // Render text with line breaks
    `[credits_bg]drawtext=text='${creditsText.replace(/\n/g, '\\n')}':fontcolor=white:fontsize=48:x=(w-text_w)/2:y=(h-text_h)/2:line_spacing=20[credits_video]`
  );
  filterComplex.push(
    `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${creditsDuration}[credits_audio]`
  );

  // Concatenate main content with credits
  filterComplex.push(
    `[main_video_temp][credits_video]concat=n=2:v=1:a=0[video_with_credits]`
  );
  filterComplex.push(
    `[main_audio_temp][credits_audio]concat=n=2:v=0:a=1[audio_with_credits]`
  );

  // --- Step 5: Add Logo Video at the Beginning ---
  let finalVideo = 'video_with_credits';
  let finalAudio = 'audio_with_credits';

  if (logoInputIndex >= 0) {
    // Concatenate logo video/audio at the start
    filterComplex.push(
      `[${logoInputIndex}:v][video_with_credits]concat=n=2:v=1:a=0[video_final_pre]`
    );
    filterComplex.push(
      `[${logoInputIndex}:a][audio_with_credits]concat=n=2:v=0:a=1[audio_final_pre]`
    );
    finalVideo = 'video_final_pre';
    finalAudio = 'audio_final_pre';
  }

  // --- Step 6: Mix Background Music ---
  if (musicInputIndex >= 0) {
    // Amix final audio track with background music
    filterComplex.push(
      `[${finalAudio}][${musicInputIndex}:a]amix=inputs=2:duration=first:dropout_transition=2[audio_final]`
    );
    finalAudio = 'audio_final';
  } else {
    // If no music, the preliminary audio is the final audio
    finalAudio = finalAudio; // Retain label
  }

  // --- Step 7: Assemble Final Command ---

  // Add all input declarations
  command += ' ' + inputs.join(' ');
  // Add the complex filter graph
  command += ` -filter_complex "${filterComplex.join(';')}"`;
  // Map final video and audio streams
  command += ` -map "[${finalVideo}]" -map "[${finalAudio}]"`;
  // Output configuration
  command += ` -c:v libx264 -preset medium -crf 23`; // Video quality and speed
  command += ` -c:a aac -b:a 128k`; // Audio codec
  command += ` -pix_fmt yuv420p`; // Standard pixel format for compatibility
  command += ` -movflags +faststart`; // Optimize for streaming
  // Use generic output filename which server.js will replace with the correct path
  command += ` output.mp4`; 

  return command;
}

module.exports = {
  buildFFmpegCommand
};
