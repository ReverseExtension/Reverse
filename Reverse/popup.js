window.addEventListener('DOMContentLoaded', () => {
  // Application-wide configuration constants
  const APP_CONFIG = {
    MAX_RECORDINGS: 100,
    MAX_RECORDING_SIZE: 48 * 1024 * 1024, // 48 MB
    TOTAL_STORAGE_LIMIT: 74 * 1024 * 1024, // 74 MB
    STORAGE_WARNING_THRESHOLD: 14 * 1024 * 1024, // 14 MB remaining
    SPEED_LEVELS: [.25, .5, .75, 1, 1.25, 1.5, 2, 3],
    DB: {
      NAME: 'AudioReverserDB',
      VERSION: 2
    },
    MIN_LOOP_DRAG_DISTANCE: 5, // Minimum pixel distance to consider a drag for looping
    DEBOUNCE_TIMES: {
      RECORD: 1000,
      PLAYBACK: 500,
      EXPORT: 1000
    },
  };

  // Cache all necessary DOM elements for efficiency
  const ELEMENTS = {
    recordBtn: document.getElementById('recordBtn'),
    visualizer: document.getElementById('visualizer'),
    visualizerContainer: document.querySelector('.visualizer-container'),
    recordingsGrid: document.getElementById('recordingsGrid'),
    recordingTemplate: document.getElementById('recordingTemplate'),
    themeToggle: document.getElementById('themeToggle'),
    statusMessage: document.getElementById('statusMessage'),
    sortSelect: document.getElementById('sortSelect'),
    storageStatus: document.getElementById('storageStatus'),
    settingsBtn: document.getElementById('settingsBtn'),
  };

  // Centralized state management for the application
  const STATE = {
    audioContext: null,
    isRecording: false,
    mediaRecorder: null,
    mediaStream: null,
    mediaStreamSource: null,
    analyserNode: null,
    recordingChunks: [],
    visualizerAnimationFrameId: null,
    currentPlayback: {
      id: null,
      sourceNode: null,
      audioBuffer: null,
      isPaused: true,
      isReversed: false,
      playbackStartTimestamp: 0,
      pauseTime: 0,
      currentDuration: 0,
      loopStart: 0,
      loopEnd: 0,
      speed: 1,
      cardElement: null,
      playbackAnimationFrameId: null,
    },
    dbInstance: null,
    sortOrder: 'newest',
    allRecordings: [],
    settings: {
      exportOriginalAndReversed: false,
      exportWithInfoFile: false
    },
    activeOperations: {
      recording: false,
      playback: false,
      export: false
    },
    debounceTimers: {
      record: null,
      playback: null,
      export: null
    },
    audioElement: null
  };

  /**
   * Debounces an action to prevent rapid, successive calls.
   * Ensures that only one operation of a given type is active at a time.
   * @param {string} action - The name of the action being performed.
   * @param {string} type - The type of operation ('record', 'playback', 'export').
   * @param {Function} callback - The function to execute after the debounce period.
   */
  function debounce(action, type, callback) {
    if (STATE.debounceTimers[type]) {
      clearTimeout(STATE.debounceTimers[type]);
    }
    if (STATE.activeOperations[type]) {
      console.log(`[DEBOUNCE] A pending ${type} operation was already active, cancelling new request.`);
      return;
    }

    STATE.debounceTimers[type] = setTimeout(async () => {
      try {
        STATE.activeOperations[type] = true;
        await callback();
      } catch (error) {
        handleError(error, `${type} operation`);
      } finally {
        STATE.activeOperations[type] = false;
      }
    }, APP_CONFIG.DEBOUNCE_TIMES[type]);
  }

  /**
   * Initializes the extension by setting up the theme, database, and event listeners.
   */
  async function initExtension() {
    try {
      console.log("[APP] Initializing extension...");
      initTheme();
      initSettings();
      STATE.dbInstance = await openDatabase();
      STATE.audioContext = new(window.AudioContext || window.webkitAudioContext)();
      setupVisualizer();
      await loadRecordings();
      updateStorageStatus();
      setupEventListeners();
      ELEMENTS.statusMessage.textContent = "Ready";
      console.log("[APP] Initialization successful.");
    } catch (error) {
      handleError(error, "Initialization failed. Check browser console for details.");
      ELEMENTS.statusMessage.textContent = "Initialization failed";
    }
  }

  /**
   * Opens or creates the IndexedDB database.
   * @returns {Promise<IDBDatabase>} A promise that resolves with the database instance.
   */
  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(APP_CONFIG.DB.NAME, APP_CONFIG.DB.VERSION);
      request.onerror = (event) => {
        console.error("[DB] Database error:", event.target.error);
        reject(new Error(`Database error: ${event.target.error.message}`));
      };
      request.onsuccess = (event) => {
        console.log("[DB] Database opened successfully.");
        resolve(event.target.result);
      };
      request.onupgradeneeded = (event) => {
        console.log("[DB] Upgrading database...");
        const db = event.target.result;
        if (!db.objectStoreNames.contains('recordings')) {
          const store = db.createObjectStore('recordings', {
            keyPath: 'id'
          });
          store.createIndex('createdAt', 'createdAt', {
            unique: false
          });
          console.log("[DB] 'recordings' object store created.");
        }
      };
    });
  }

  /**
   * Fetches all recordings from the IndexedDB.
   * @returns {Promise<Array<Object>>} A promise that resolves with an array of recordings.
   */
  async function getRecordingsFromDB() {
    return new Promise((resolve, reject) => {
      try {
        const transaction = STATE.dbInstance.transaction(['recordings'], 'readonly');
        const store = transaction.objectStore('recordings');
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = (event) => {
          console.error("[DB] Failed to get recordings:", event.target.error);
          reject(new Error(`Failed to get recordings: ${event.target.error.message}`));
        };
      } catch (error) {
        handleError(error, "getRecordingsFromDB");
        reject(error);
      }
    });
  }

  /**
   * Saves a new recording to the IndexedDB.
   * @param {Object} recording - The recording object to save.
   * @returns {Promise<void>}
   */
  async function saveRecording(recording) {
    return new Promise((resolve, reject) => {
      try {
        const transaction = STATE.dbInstance.transaction(['recordings'], 'readwrite');
        const store = transaction.objectStore('recordings');
        const request = store.put(recording);
        request.onsuccess = () => {
          console.log(`[DB] Recording ${recording.id} saved successfully.`);
          resolve();
        };
        request.onerror = (event) => {
          console.error(`[DB] Failed to save recording ${recording.id}:`, event.target.error);
          reject(new Error(`Failed to save recording: ${event.target.error.message}`));
        };
      } catch (error) {
        handleError(error, "saveRecording");
        reject(error);
      }
    });
  }

  /**
   * Deletes a recording from the IndexedDB.
   * @param {string} id - The ID of the recording to delete.
   * @returns {Promise<void>}
   */
  async function deleteRecordingFromDB(id) {
    return new Promise((resolve, reject) => {
      try {
        const transaction = STATE.dbInstance.transaction(['recordings'], 'readwrite');
        const store = transaction.objectStore('recordings');
        const request = store.delete(id);
        request.onsuccess = () => {
          console.log(`[DB] Recording ${id} deleted successfully.`);
          resolve();
        };
        request.onerror = (event) => {
          console.error(`[DB] Failed to delete recording ${id}:`, event.target.error);
          reject(new Error(`Failed to delete recording: ${event.target.error.message}`));
        };
      } catch (error) {
        handleError(error, "deleteRecordingFromDB");
        reject(error);
      }
    });
  }

  /**
   * Captures the audio stream from the current tab.
   * @returns {Promise<MediaStream>} A promise that resolves with the captured MediaStream.
   */
  async function captureTabAudio() {
    return new Promise((resolve, reject) => {
      chrome.tabCapture.capture({
        audio: true,
        video: false
      }, (stream) => {
        if (chrome.runtime.lastError || !stream) {
          const errorMessage = chrome.runtime.lastError?.message || 'Failed to capture tab audio';
          console.error(`[RECORDING] Tab audio capture failed: ${errorMessage}`);
          reject(new Error(errorMessage));
          return;
        }

        // Create an audio element to keep the stream active and audible.
        // The original code muted the stream here, which caused the silent tab.
        STATE.audioElement = new Audio();
        STATE.audioElement.srcObject = stream;
        STATE.audioElement.play().catch(e => console.error("Audio playback error:", e));

        console.log("[RECORDING] Tab audio captured successfully.");
        resolve(stream);
      });
    });
  }

  /**
   * Processes the raw audio data, creating original and reversed audio buffers.
   * @param {Blob} audioData - The raw audio data as a Blob.
   * @returns {Promise<Object>} An object containing original and reversed audio data and duration.
   */
  async function processAudioBuffer(audioData) {
    try {
      const arrayBuffer = await audioData.arrayBuffer();
      const audioBuffer = await STATE.audioContext.decodeAudioData(arrayBuffer);
      const reversedBuffer = STATE.audioContext.createBuffer(
        audioBuffer.numberOfChannels,
        audioBuffer.length,
        audioBuffer.sampleRate
      );
      for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
        const originalData = audioBuffer.getChannelData(channel);
        const reversedData = reversedBuffer.getChannelData(channel);
        for (let i = 0; i < originalData.length; i++) {
          reversedData[i] = originalData[originalData.length - 1 - i];
        }
      }
      console.log("[AUDIO] Audio buffer processed and reversed.");
      return {
        original: Array.from(audioBuffer.getChannelData(0)),
        reversed: Array.from(reversedBuffer.getChannelData(0)),
        duration: Math.round(audioBuffer.duration * 1000)
      };
    } catch (error) {
      handleError(error, "Audio Processing");
      throw new Error(`Audio processing failed: ${error.message}`);
    }
  }

  /**
   * Deserializes a raw audio data array back into a usable AudioBuffer.
   * @param {Array<number>} serialized - The serialized audio data.
   * @returns {Promise<AudioBuffer>} A promise that resolves with the AudioBuffer.
   */
  async function deserializeAudioBuffer(serialized) {
    try {
      if (!STATE.audioContext) throw new Error("AudioContext not initialized.");
      const audioBuffer = STATE.audioContext.createBuffer(1, serialized.length, STATE.audioContext.sampleRate);
      audioBuffer.getChannelData(0).set(new Float32Array(serialized));
      return audioBuffer;
    } catch (error) {
      handleError(error, "Deserializing audio buffer");
      throw error;
    }
  }

  /**
   * Stops the current audio playback.
   */
  function stopPlayback() {
    const {
      currentPlayback
    } = STATE;
    if (currentPlayback.sourceNode) {
      console.log(`[PLAYBACK] Stopping playback for recording ${currentPlayback.id}.`);
      try {
        currentPlayback.sourceNode.stop();
        currentPlayback.sourceNode.disconnect();
      } catch (e) {
        console.warn("[PLAYBACK] Error stopping source node:", e);
      }
      currentPlayback.sourceNode = null;
    }
    if (currentPlayback.playbackAnimationFrameId) {
      cancelAnimationFrame(currentPlayback.playbackAnimationFrameId);
      currentPlayback.playbackAnimationFrameId = null;
    }
  }

  /**
   * Pauses the current audio playback.
   */
  function pausePlayback() {
    const {
      currentPlayback
    } = STATE;
    if (currentPlayback.isPaused || !currentPlayback.sourceNode) return;
    const elapsedSeconds = (performance.now() - currentPlayback.playbackStartTimestamp) / 1000;
    let newPauseTime;
    if (currentPlayback.sourceNode.loop) {
      const loopDuration = currentPlayback.loopEnd - currentPlayback.loopStart;
      newPauseTime = currentPlayback.loopStart + ((elapsedSeconds - currentPlayback.loopStart) % loopDuration);
    } else {
      newPauseTime = elapsedSeconds;
    }

    if (currentPlayback.isReversed) {
      newPauseTime = currentPlayback.audioBuffer.duration - newPauseTime;
    }

    currentPlayback.pauseTime = newPauseTime;
    currentPlayback.isPaused = true;
    stopPlayback();
    updatePlaybackUI();
    ELEMENTS.statusMessage.textContent = "Paused";
    console.log(`[PLAYBACK] Playback paused at ${currentPlayback.pauseTime.toFixed(2)}s.`);
  }

  /**
   * Starts playback of a specific recording.
   * @param {string} recordingId - The ID of the recording to play.
   * @param {boolean} reverse - Whether to play the reversed version.
   * @param {number} startTime - The time (in seconds) to start playback from.
   * @param {number} loopStart - The loop start time (in seconds).
   * @param {number} loopEnd - The loop end time (in seconds).
   * @returns {Promise<void>}
   */
  async function startPlayback(recordingId, reverse = false, startTime = 0, loopStart = 0, loopEnd = 0) {
    stopPlayback();
    try {
      STATE.activeOperations.playback = true;
      console.log(`[PLAYBACK] Starting playback for recording ${recordingId} from ${startTime.toFixed(2)}s. Reversed: ${reverse}`);
      ELEMENTS.statusMessage.textContent = "Loading recording...";
      const recording = STATE.allRecordings.find(r => r.id === recordingId);
      if (!recording) throw new Error("Recording not found in state.");
      const card = document.querySelector(`.recording-card[data-id="${recordingId}"]`);

      const buffer = await deserializeAudioBuffer(reverse ? recording.reversed : recording.original);
      const sourceNode = STATE.audioContext.createBufferSource();
      sourceNode.buffer = buffer;
      sourceNode.playbackRate.value = STATE.currentPlayback.speed;
      sourceNode.connect(STATE.audioContext.destination);

      STATE.currentPlayback = {
        ...STATE.currentPlayback,
        id: recordingId,
        sourceNode: sourceNode,
        audioBuffer: buffer,
        isReversed: reverse,
        currentDuration: buffer.duration,
        cardElement: card,
        isPaused: false,
        pauseTime: startTime,
        loopStart: loopStart,
        loopEnd: loopEnd,
      };

      let playbackStartTime = startTime;
      let playbackLoopStart = loopStart;
      let playbackLoopEnd = loopEnd;

      if (reverse) {
        const duration = buffer.duration;
        playbackStartTime = duration - startTime;
        playbackLoopStart = duration - loopEnd;
        playbackLoopEnd = duration - loopStart;
      }

      const scaledPlaybackStartTime = playbackStartTime / STATE.currentPlayback.speed;
      const scaledPlaybackLoopStart = playbackLoopStart / STATE.currentPlayback.speed;
      const scaledPlaybackLoopEnd = playbackLoopEnd / STATE.currentPlayback.speed;

      if (scaledPlaybackLoopEnd > scaledPlaybackLoopStart) {
        sourceNode.loop = true;
        sourceNode.loopStart = scaledPlaybackLoopStart;
        sourceNode.loopEnd = scaledPlaybackLoopEnd;
        console.log(`[PLAYBACK] Looping enabled from ${scaledPlaybackLoopStart.toFixed(2)}s to ${scaledPlaybackLoopEnd.toFixed(2)}s.`);
      } else {
        sourceNode.loop = false;
        console.log("[PLAYBACK] Looping disabled.");
      }

      STATE.currentPlayback.playbackStartTimestamp = performance.now() - (scaledPlaybackStartTime * 1000);
      sourceNode.start(0, scaledPlaybackStartTime);
      sourceNode.onended = () => {
        if (STATE.currentPlayback.id === recordingId && !sourceNode.loop && !STATE.currentPlayback.isPaused) {
          console.log(`[PLAYBACK] Playback for ${recordingId} finished.`);
          resetPlaybackState(true);
        }
      };
      updatePlaybackUI();
      ELEMENTS.statusMessage.textContent = reverse ? "Playing reversed..." : "Playing...";
      console.log(`[PLAYBACK] Playback started for ${recordingId}.`);
    } catch (error) {
      handleError(error, "Playback");
      resetPlaybackState();
    } finally {
      STATE.activeOperations.playback = false;
    }
  }

  /**
   * Resets the playback state to its initial values.
   * @param {boolean} preserveReversedState - If true, keeps the current reversed state.
   */
  function resetPlaybackState(preserveReversedState = false) {
    stopPlayback();
    const reversedState = preserveReversedState ? STATE.currentPlayback.isReversed : false;
    STATE.currentPlayback = {
      id: null,
      sourceNode: null,
      audioBuffer: null,
      isPaused: true,
      isReversed: reversedState,
      playbackStartTimestamp: 0,
      pauseTime: 0,
      currentDuration: 0,
      loopStart: 0,
      loopEnd: 0,
      speed: 1,
      cardElement: null,
      playbackAnimationFrameId: null,
    };
    updateAllPlaybackCardUIs();
    ELEMENTS.statusMessage.textContent = "Ready";
    console.log("[PLAYBACK] Playback state reset.");
  }

  /**
   * Toggles play/pause for a given recording.
   * @param {string} recordingId - The ID of the recording.
   */
  function togglePlayPause(recordingId) {
    const isCurrentTrack = STATE.currentPlayback.id === recordingId;
    const isCurrentTrackPlaying = isCurrentTrack && !STATE.currentPlayback.isPaused;
    const isCurrentTrackReversed = isCurrentTrack && STATE.currentPlayback.isReversed;
    if (isCurrentTrackPlaying) {
      pausePlayback();
    } else {
      if (STATE.currentPlayback.id && !isCurrentTrack) {
        resetPlaybackState();
      }
      const card = document.querySelector(`.recording-card[data-id="${recordingId}"]`);
      const speedDisplay = card.querySelector('.speed-display');
      const newSpeed = parseFloat(speedDisplay.textContent.replace('x', ''));
      STATE.currentPlayback.speed = newSpeed;

      const startReversed = isCurrentTrackReversed;
      const startTime = isCurrentTrack ? STATE.currentPlayback.pauseTime : 0;
      const loopStart = isCurrentTrack ? STATE.currentPlayback.loopStart : 0;
      const loopEnd = isCurrentTrack ? STATE.currentPlayback.loopEnd : 0;
      startPlayback(recordingId, startReversed, startTime, loopStart, loopEnd);
    }
  }

  /**
   * Toggles the reversed state of a recording and restarts playback.
   * @param {string} recordingId - The ID of the recording.
   */
  async function toggleReverse(recordingId) {
    const {
      currentPlayback
    } = STATE;
    console.log(`[PLAYBACK] Toggling reverse for recording ${recordingId}.`);

    const isCurrentTrack = currentPlayback.id === recordingId;
    // Toggling reverse for a new track will automatically start it reversed.
    const newReverseState = isCurrentTrack ? !currentPlayback.isReversed : true;
    const newPauseTime = isCurrentTrack ? currentPlayback.pauseTime : 0;
    const newLoopStart = isCurrentTrack ? currentPlayback.loopStart : 0;
    const newLoopEnd = isCurrentTrack ? currentPlayback.loopEnd : 0;

    stopPlayback();
    await startPlayback(recordingId, newReverseState, newPauseTime, newLoopStart, newLoopEnd);
  }

  /**
   * Updates the UI for the currently playing recording.
   */
  function updatePlaybackUI() {
    const {
      currentPlayback
    } = STATE;
    if (!currentPlayback.id || !currentPlayback.cardElement) {
      updateAllPlaybackCardUIs();
      return;
    }
    const playingCard = currentPlayback.cardElement;
    const canvas = playingCard.querySelector('canvas');
    const playButton = playingCard.querySelector('.play-btn');
    const allCards = document.querySelectorAll('.recording-card');
    const allControls = document.querySelectorAll('.control-btn, .icon-btn');
    allCards.forEach(card => card.classList.remove('playing'));
    playingCard.classList.add('playing');
    allControls.forEach(btn => {
      if (!playingCard.contains(btn) && btn.id !== 'recordBtn' && btn.id !== 'themeToggle' && btn.id !== 'settingsBtn') {
        btn.disabled = true;
      } else {
        btn.disabled = false;
      }
    });
    updatePlayButton(playButton, !currentPlayback.isPaused);

    const drawFrame = () => {
      if (STATE.currentPlayback.isPaused || !STATE.currentPlayback.id) {
        cancelAnimationFrame(STATE.currentPlayback.playbackAnimationFrameId);
        STATE.currentPlayback.playbackAnimationFrameId = null;
        return;
      }

      const elapsedSeconds = (performance.now() - STATE.currentPlayback.playbackStartTimestamp) / 1000;
      let currentTime = elapsedSeconds * STATE.currentPlayback.speed;

      if (STATE.currentPlayback.sourceNode.loop) {
        const loopDuration = STATE.currentPlayback.loopEnd - STATE.currentPlayback.loopStart;
        const loopElapsed = currentTime - STATE.currentPlayback.loopStart;
        currentTime = STATE.currentPlayback.loopStart + (loopElapsed % loopDuration);
      }

      const displayedTime = STATE.currentPlayback.isReversed ? STATE.currentPlayback.audioBuffer.duration - currentTime : currentTime;

      drawWaveform(
        STATE.currentPlayback.audioBuffer,
        canvas,
        displayedTime,
        STATE.currentPlayback.loopStart,
        STATE.currentPlayback.loopEnd,
        STATE.currentPlayback.isReversed
      );

      STATE.currentPlayback.playbackAnimationFrameId = requestAnimationFrame(drawFrame);
    };

    if (!currentPlayback.isPaused) {
      if (currentPlayback.playbackAnimationFrameId) {
        cancelAnimationFrame(currentPlayback.playbackAnimationFrameId);
      }
      currentPlayback.playbackAnimationFrameId = requestAnimationFrame(drawFrame);
    } else {
      const displayedTime = currentPlayback.isReversed ? currentPlayback.audioBuffer.duration - currentPlayback.pauseTime : currentPlayback.pauseTime;
      drawWaveform(
        currentPlayback.audioBuffer,
        canvas,
        displayedTime,
        currentPlayback.loopStart,
        currentPlayback.loopEnd,
        currentPlayback.isReversed
      );
    }
  }

  /**
   * Resets the UI for all playback cards.
   */
  function updateAllPlaybackCardUIs() {
    document.querySelectorAll('.recording-card').forEach(card => card.classList.remove('playing'));
    document.querySelectorAll('.control-btn, .icon-btn').forEach(btn => {
      btn.disabled = false;
      if (btn.classList.contains('play-btn')) {
        updatePlayButton(btn, false);
      }
    });
    document.querySelectorAll('.playback-bar').forEach(bar => bar.style.width = '0%');
  }

  /**
   * Updates the play/pause button icon and text.
   * @param {HTMLElement} button - The button element.
   * @param {boolean} isPlaying - Whether the track is currently playing.
   */
  function updatePlayButton(button, isPlaying) {
    const icon = button.querySelector('i');
    const text = button.querySelector('span');
    if (isPlaying) {
      button.classList.add('playing');
      icon.className = 'fas fa-pause';
      text.textContent = 'Pause';
    } else {
      button.classList.remove('playing');
      icon.className = 'fas fa-play';
      text.textContent = 'Play';
    }
  }

  /**
   * Updates the playback speed and restarts playback if necessary.
   * @param {number} newSpeedIndex - The index of the new speed in APP_CONFIG.SPEED_LEVELS.
   */
  async function updatePlaybackSpeed(newSpeedIndex) {
    const newSpeed = APP_CONFIG.SPEED_LEVELS[newSpeedIndex];
    STATE.currentPlayback.speed = newSpeed;
    console.log(`[PLAYBACK] Playback speed updated to ${newSpeed.toFixed(2)}x.`);

    if (STATE.currentPlayback.id) {
      await startPlayback(
        STATE.currentPlayback.id,
        STATE.currentPlayback.isReversed,
        STATE.currentPlayback.pauseTime,
        STATE.currentPlayback.loopStart,
        STATE.currentPlayback.loopEnd
      );
    }
  }

  /**
   * Draws the waveform on a canvas.
   * @param {AudioBuffer} buffer - The audio buffer to visualize.
   * @param {HTMLCanvasElement} canvas - The canvas element to draw on.
   * @param {number} currentTime - The current playback time.
   * @param {number} loopStart - The loop start time.
   * @param {number} loopEnd - The loop end time.
   * @param {boolean} isReversed - Whether the audio is reversed.
   * @param {number} dragLoopStart - The temporary loop start from a drag.
   * @param {number} dragLoopEnd - The temporary loop end from a drag.
   */
  function drawWaveform(buffer, canvas, currentTime = -1, loopStart = -1, loopEnd = -1, isReversed = false, dragLoopStart = -1, dragLoopEnd = -1) {
    if (!buffer || !canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    const theme = document.documentElement.classList.contains('theme-light') ? 'light' : 'dark';
    if (theme === 'light') {
      gradient.addColorStop(0, '#740000');
      gradient.addColorStop(1, '#141414');
    } else {
      gradient.addColorStop(0, '#fff');
      gradient.addColorStop(1, '#ff000074');
    }
    const data = buffer.getChannelData(0);
    const step = Math.ceil(data.length / width);
    const amp = height / 2;
    ctx.lineWidth = 1;
    ctx.strokeStyle = gradient;
    ctx.beginPath();
    for (let i = 0; i < width; i++) {
      let min = 1.0;
      let max = -1.0;
      for (let j = 0; j < step; j++) {
        const datum = data[(i * step) + j];
        if (datum < min) min = datum;
        if (datum > max) max = datum;
      }
      ctx.moveTo(i, (1 + min) * amp);
      ctx.lineTo(i, (1 + max) * amp);
    }
    ctx.stroke();

    if (loopEnd > loopStart) {
      const totalDuration = buffer.duration;
      const displayLoopStart = isReversed ? totalDuration - loopEnd : loopStart;
      const displayLoopEnd = isReversed ? totalDuration - loopStart : loopEnd;

      const startX = (displayLoopStart / totalDuration) * width;
      const endX = (displayLoopEnd / totalDuration) * width;
      ctx.fillStyle = 'rgba(108, 92, 231, 0.3)';
      ctx.fillRect(startX, 0, endX - startX, height);
      ctx.strokeStyle = '#6c5ce7';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.moveTo(startX, 0);
      ctx.lineTo(startX, height);
      ctx.moveTo(endX, 0);
      ctx.lineTo(endX, height);
      ctx.stroke();
    }

    if (dragLoopEnd > dragLoopStart) {
      const totalDuration = buffer.duration;
      const startX = (dragLoopStart / totalDuration) * width;
      const endX = (dragLoopEnd / totalDuration) * width;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.fillRect(startX, 0, endX - startX, height);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.moveTo(startX, 0);
      ctx.lineTo(startX, height);
      ctx.moveTo(endX, 0);
      ctx.lineTo(endX, height);
      ctx.stroke();
    }

    if (currentTime >= 0) {
      const playX = (currentTime / buffer.duration) * width;
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--waveform-progress').trim();
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.moveTo(playX, 0);
      ctx.lineTo(playX, height);
      ctx.stroke();
    }
  }

  /**
   * Creates a new recording card element.
   * @param {Object} recording - The recording data.
   * @returns {HTMLElement} The created recording card element.
   */
  function createRecordingCard(recording) {
    const card = ELEMENTS.recordingTemplate.content.cloneNode(true).firstElementChild;
    const date = new Date(recording.createdAt);
    card.dataset.id = recording.id;
    card.querySelector('.card-title').textContent = `Recording_${date.getHours()}${date.getMinutes()}`;
    card.querySelector('.card-time').textContent = formatDuration(recording.duration);
    const waveformCanvas = card.querySelector('.waveform-container canvas');
    const playBtn = card.querySelector('.play-btn');
    const reverseBtn = card.querySelector('.reverse-btn');
    const deleteBtn = card.querySelector('.delete-btn');
    const exportBtn = card.querySelector('.export-btn');
    const speedDownBtn = card.querySelector('.speedDown');
    const speedUpBtn = card.querySelector('.speedUp');
    const speedDisplay = card.querySelector('.speed-display');

    let waveformBuffer = null;
    deserializeAudioBuffer(recording.original)
      .then(buffer => {
        waveformBuffer = buffer;
        drawWaveform(waveformBuffer, waveformCanvas);
      })
      .catch(err => console.error('Waveform error:', err));

    let isDragging = false;
    let dragStartX = 0;

    waveformCanvas.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!waveformBuffer) return;
      stopPlayback();
      isDragging = true;
      dragStartX = e.offsetX;
    });

    waveformCanvas.addEventListener('mousemove', (e) => {
      if (!isDragging || !waveformBuffer) return;
      e.preventDefault();
      const dragEndX = e.offsetX;
      const canvasWidth = waveformCanvas.offsetWidth;
      const totalDuration = waveformBuffer.duration;
      const dragLoopStart = (Math.min(dragStartX, dragEndX) / canvasWidth) * totalDuration;
      const dragLoopEnd = (Math.max(dragStartX, dragEndX) / canvasWidth) * totalDuration;

      drawWaveform(
        waveformBuffer,
        waveformCanvas,
        -1,
        -1,
        -1,
        false,
        dragLoopStart,
        dragLoopEnd
      );
    });

    waveformCanvas.addEventListener('mouseup', async (e) => {
      if (!isDragging || !waveformBuffer) return;
      e.preventDefault();
      isDragging = false;
      const canvasWidth = waveformCanvas.offsetWidth;
      const totalDuration = waveformBuffer.duration;
      const finalX = e.offsetX;
      const startX = Math.min(dragStartX, finalX);
      const endX = Math.max(dragStartX, finalX);

      if (Math.abs(dragStartX - finalX) < APP_CONFIG.MIN_LOOP_DRAG_DISTANCE) {
        const seekTime = (finalX / canvasWidth) * totalDuration;
        console.log(`[UI] Click detected. Seeking to ${seekTime.toFixed(2)}s and clearing loop points.`);

        const isReversed = STATE.currentPlayback.id === recording.id ? STATE.currentPlayback.isReversed : false;
        stopPlayback();
        STATE.currentPlayback.isReversed = isReversed;
        await startPlayback(recording.id, isReversed, seekTime, 0, 0);
      } else {
        const newLoopStart = (startX / canvasWidth) * totalDuration;
        const newLoopEnd = (endX / canvasWidth) * totalDuration;
        console.log(`[UI] Drag detected. Setting loop points from ${newLoopStart.toFixed(2)}s to ${newLoopEnd.toFixed(2)}s.`);

        const isReversed = STATE.currentPlayback.id === recording.id ? STATE.currentPlayback.isReversed : false;
        stopPlayback();
        STATE.currentPlayback.isReversed = isReversed;
        await startPlayback(recording.id, isReversed, newLoopStart, newLoopStart, newLoopEnd);
      }
    });

    waveformCanvas.addEventListener('mouseleave', () => {
      if (isDragging) {
        isDragging = false;
        if (waveformBuffer) {
          drawWaveform(waveformBuffer, waveformCanvas);
        }
      }
    });

    playBtn.addEventListener('click', () => togglePlayPause(recording.id));
    reverseBtn.addEventListener('click', () => toggleReverse(recording.id));
    deleteBtn.addEventListener('click', () => deleteRecording(recording.id));
    exportBtn.addEventListener('click', () => debounce('export', 'export', () => exportRecording(recording)));

    let speedIndex = APP_CONFIG.SPEED_LEVELS.indexOf(1);
    speedDisplay.textContent = `${APP_CONFIG.SPEED_LEVELS[speedIndex].toFixed(2)}x`;
    speedDownBtn.addEventListener('click', () => {
      if (speedIndex > 0) speedIndex--;
      speedDisplay.textContent = `${APP_CONFIG.SPEED_LEVELS[speedIndex].toFixed(2)}x`;
      if (STATE.currentPlayback.id === recording.id) {
        updatePlaybackSpeed(speedIndex);
      }
    });
    speedUpBtn.addEventListener('click', () => {
      if (speedIndex < APP_CONFIG.SPEED_LEVELS.length - 1) speedIndex++;
      speedDisplay.textContent = `${APP_CONFIG.SPEED_LEVELS[speedIndex].toFixed(2)}x`;
      if (STATE.currentPlayback.id === recording.id) {
        updatePlaybackSpeed(speedIndex);
      }
    });

    return card;
  }

  /**
   * Calculates the size of a recording in bytes.
   * @param {Object} recording - The recording object.
   * @returns {number} The size of the recording in bytes.
   */
  function calculateRecordingSize(recording) {
    return (recording.original.length + recording.reversed.length) * 4;
  }

  /**
   * Calculates current storage usage.
   * @returns {Promise<Object>} An object with storage statistics.
   */
  async function getStorageUsage() {
    try {
      const recordings = await getRecordingsFromDB();
      let totalSize = 0;
      recordings.forEach(rec => {
        totalSize += calculateRecordingSize(rec);
      });
      return {
        count: recordings.length,
        totalSize,
        remaining: APP_CONFIG.TOTAL_STORAGE_LIMIT - totalSize
      };
    } catch (error) {
      handleError(error, "getStorageUsage");
      throw error;
    }
  }

  /**
   * Updates the storage status UI element.
   */
  async function updateStorageStatus() {
    try {
      const storage = await getStorageUsage();
      const sizeInMB = (storage.totalSize / (1024 * 1024)).toFixed(1);
      const remainingMB = (storage.remaining / (1024 * 1024)).toFixed(1);
      const maxMB = (APP_CONFIG.TOTAL_STORAGE_LIMIT / (1024 * 1024)).toFixed(0);
      let statusClass = '';
      if (storage.remaining <= 0) {
        statusClass = 'storage-full';
      } else if (storage.remaining <= APP_CONFIG.STORAGE_WARNING_THRESHOLD) {
        statusClass = 'storage-warning';
      }
      ELEMENTS.storageStatus.innerHTML = `
        <i class="fas fa-database ${statusClass}"></i>
        <span class="${statusClass}">${storage.count}/${APP_CONFIG.MAX_RECORDINGS} recordings (${sizeInMB}MB/${maxMB}MB)</span>
      `;
      ELEMENTS.storageStatus.title = `${remainingMB}MB remaining (${Math.round((storage.totalSize / APP_CONFIG.TOTAL_STORAGE_LIMIT) * 100)}% used)`;
      console.log(`[STORAGE] Storage status updated: ${sizeInMB}MB used, ${remainingMB}MB remaining.`);
    } catch (error) {
      console.error('Storage status update failed:', error);
      ELEMENTS.storageStatus.innerHTML = `
        <i class="fas fa-database"></i>
        Storage info unavailable
      `;
    }
  }

  /**
   * Loads all recordings from the database and renders them.
   */
  async function loadRecordings() {
    try {
      console.log("[APP] Loading recordings from database...");
      STATE.allRecordings = await getRecordingsFromDB();
      STATE.allRecordings.sort((a, b) => {
        if (STATE.sortOrder === 'newest') {
          return b.createdAt - a.createdAt;
        } else {
          return a.createdAt - b.createdAt;
        }
      });
      ELEMENTS.recordingsGrid.innerHTML = '';
      if (STATE.allRecordings.length === 0) {
        ELEMENTS.recordingsGrid.innerHTML = `
          <div class="empty-state">
            <p>Welcome to Reverse. Record an audio stream, then either reverse, export, or adjust playback rate. Submit bug reports to wowwow@wowwow</p>
          </div>
        `;
        console.log("[APP] No recordings found in database.");
        return;
      }
      STATE.allRecordings.forEach(recording => {
        ELEMENTS.recordingsGrid.appendChild(createRecordingCard(recording));
      });
      console.log(`[APP] Successfully loaded ${STATE.allRecordings.length} recordings.`);
    } catch (error) {
      handleError(error, "loadRecordings");
      ELEMENTS.recordingsGrid.innerHTML = `
        <div class="error-state">
          <i class="fas fa-exclamation-triangle"></i>
          <p>Failed to load recordings</p>
        </div>
      `;
    }
  }

  /**
   * Formats a duration in milliseconds to a mm:ss string.
   * @param {number} ms - The duration in milliseconds.
   * @returns {string} The formatted duration string.
   */
  function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  /**
   * Deletes a recording and updates the UI.
   * @param {string} recordingId - The ID of the recording to delete.
   * @returns {Promise<void>}
   */
  async function deleteRecording(recordingId) {
    try {
      console.log(`[APP] Attempting to delete recording ${recordingId}.`);
      if (STATE.currentPlayback.id === recordingId) {
        resetPlaybackState();
      }
      ELEMENTS.statusMessage.textContent = "Deleting recording...";
      await deleteRecordingFromDB(recordingId);
      const cardToRemove = document.querySelector(`.recording-card[data-id="${recordingId}"]`);
      if (cardToRemove) {
        cardToRemove.remove();
      }
      await loadRecordings();
      updateStorageStatus();
      ELEMENTS.statusMessage.textContent = "Recording deleted";
    } catch (error) {
      handleError(error, "deleteRecording");
      ELEMENTS.statusMessage.textContent = "Failed to delete recording";
    }
  }

  /**
   * Exports a single recording as a WAV file.
   * @param {Object} recording - The recording to export.
   * @returns {Promise<void>}
   */
  async function exportRecording(recording) {
    if (STATE.activeOperations.export) {
      console.log("[EXPORT] Export operation already in progress");
    }

    try {
      STATE.activeOperations.export = true;
      console.log(`[APP] Preparing to export recording ${recording.id}.`);
      ELEMENTS.statusMessage.textContent = "Preparing export...";

      const dateStr = new Date(recording.createdAt).toISOString().replace(/[:.]/g, '-');
      let recordingName = `recording_${dateStr}`;

      const isCurrentTrackReversed = STATE.currentPlayback.id === recording.id && STATE.currentPlayback.isReversed;
      const trackToExport = isCurrentTrackReversed ? recording.reversed : recording.original;

      const buffer = await deserializeAudioBuffer(trackToExport);
      const blob = await audioBufferToWav(buffer);

      if (isCurrentTrackReversed) {
        recordingName += '_reversed';
      }

      await downloadFile(blob, `${recordingName}.wav`);

      ELEMENTS.statusMessage.textContent = "Export complete";
      console.log("[APP] Export complete.");
    } catch (error) {
      handleError(error, "exportRecording");
      ELEMENTS.statusMessage.textContent = "Export failed";
    } finally {
      STATE.activeOperations.export = false;
    }
  }

  /**
   * Converts an AudioBuffer to a WAV Blob.
   * @param {AudioBuffer} buffer - The audio buffer to convert.
   * @returns {Promise<Blob>} A promise that resolves with the WAV Blob.
   */
  async function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const length = buffer.length;
    const sampleRate = buffer.sampleRate;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const wavBuffer = new ArrayBuffer(44 + length * blockAlign);
    const view = new DataView(wavBuffer);
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + length * blockAlign, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    writeString(view, 36, 'data');
    view.setUint32(40, length * blockAlign, true);
    const offset = 44;
    for (let channel = 0; channel < numChannels; channel++) {
      const channelData = buffer.getChannelData(channel);
      for (let i = 0; i < channelData.length; i++) {
        const sample = Math.max(-1, Math.min(1, channelData[i]));
        view.setInt16(offset + (i * blockAlign) + (channel * bytesPerSample),
          sample < 0 ? sample * 32768 : sample * 32767, true);
      }
    }
    return new Blob([view], {
      type: 'audio/wav'
    });
  }

  /**
   * Writes a string to a DataView.
   * @param {DataView} view - The DataView to write to.
   * @param {number} offset - The byte offset to start writing at.
   * @param {string} string - The string to write.
   */
  function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  /**
   * Shows a modal alert message to the user.
   * @param {string} title - The title of the alert.
   * @param {string} message - The message body.
   */
  function showAlertModal(title, message) {
    const existingModal = document.getElementById('limitAlertModal');
    if (existingModal) existingModal.remove();
    const modal = document.createElement('div');
    modal.id = 'limitAlertModal';
    modal.className = 'limit-alert-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <h3>${title}</h3>
        <p>${message}</p>
        <button class="modal-close-btn">OK</button>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('.modal-close-btn').addEventListener('click', () => {
      modal.remove();
    });
  }

  /**
   * Global error handler for logging and displaying errors.
   * @param {Error} error - The error object.
   * @param {string} context - The context in which the error occurred.
   */
  function handleError(error, context) {
    console.error(`[ERROR] [${new Date().toISOString()}] - ${context}`, error);
    ELEMENTS.statusMessage.textContent = `Error: ${context}`;
    showAlertModal(`Error: ${context}`, error.message || String(error));
  }

  /**
   * Sets up all main event listeners.
   */
  function setupEventListeners() {
    ELEMENTS.recordBtn.addEventListener('click', () => {
      if (STATE.activeOperations.recording) {
        console.log("[RECORDING] Recording operation pending, ignoring click.");
        return;
      }
      debounce('record', 'recording', () => {
        STATE.isRecording ? stopRecording() : startRecording();
      });
    });

    ELEMENTS.themeToggle.addEventListener('click', () => {
      const isLight = document.documentElement.classList.toggle('theme-light');
      const theme = isLight ? 'light' : 'dark';
      localStorage.setItem('audioReverserTheme', theme);
      updateThemeIcon(theme);
      console.log(`[APP] Theme toggled to ${theme}.`);
    });

    ELEMENTS.sortSelect.addEventListener('change', async (e) => {
      console.log(`[APP] Sorting recordings by ${e.target.value}.`);
      STATE.sortOrder = e.target.value;
      await loadRecordings();
      resetPlaybackState();
    });

    ELEMENTS.settingsBtn.addEventListener('click', showSettingsModal);

    window.addEventListener('beforeunload', () => {
      resetPlaybackState();
      cleanupRecordingResources();
      console.log("[APP] Window is unloading. Resources cleaned up.");
    });
  }

  /**
   * Initializes the theme based on local storage.
   */
  function initTheme() {
    const savedTheme = localStorage.getItem('audioReverserTheme') || 'dark';
    document.documentElement.classList.toggle('theme-light', savedTheme === 'light');
    updateThemeIcon(savedTheme);
    console.log(`[APP] Initial theme set to ${savedTheme}.`);
  }

  /**
   * Initializes settings based on local storage.
   */
  function initSettings() {
    const savedSettings = JSON.parse(localStorage.getItem('audioReverserSettings')) || {};
    STATE.settings = { ...STATE.settings,
      ...savedSettings
    };
    console.log("[APP] Initial settings loaded.", STATE.settings);
  }

  /**
   * Saves settings to local storage.
   */
  function saveSettings() {
    localStorage.setItem('audioReverserSettings', JSON.stringify(STATE.settings));
    console.log("[APP] Settings saved.", STATE.settings);
  }

  /**
   * Updates the theme toggle icon.
   * @param {string} theme - The current theme ('light' or 'dark').
   */
  function updateThemeIcon(theme) {
    const icon = ELEMENTS.themeToggle.querySelector('i');
    icon.className = theme === 'light' ? 'fas fa-moon' : 'fas fa-sun';
  }

  /**
   * Sets up the visualizer canvas.
   */
  function setupVisualizer() {
    ELEMENTS.visualizer.width = ELEMENTS.visualizer.offsetWidth * window.devicePixelRatio;
    ELEMENTS.visualizer.height = ELEMENTS.visualizer.offsetHeight * window.devicePixelRatio;
  }

  /**
   * Starts the visualization animation loop.
   */
  function startVisualization() {
    if (!STATE.analyserNode) return;
    if (!STATE.visualizerAnimationFrameId) {
      STATE.visualizerAnimationFrameId = requestAnimationFrame(drawVisualizer);
    }
  }

  /**
   * Stops the visualization animation loop and clears the canvas.
   */
  function stopVisualization() {
    if (STATE.visualizerAnimationFrameId) {
      cancelAnimationFrame(STATE.visualizerAnimationFrameId);
      STATE.visualizerAnimationFrameId = null;
      const ctx = ELEMENTS.visualizer.getContext('2d');
      ctx.clearRect(0, 0, ELEMENTS.visualizer.width, ELEMENTS.visualizer.height);
    }
  }

  /**
   * Draws the real-time audio visualization.
   */
  function drawVisualizer() {
    if (!STATE.analyserNode || !ELEMENTS.visualizer) {
      STATE.visualizerAnimationFrameId = null;
      return;
    }
    const ctx = ELEMENTS.visualizer.getContext('2d');
    const width = ELEMENTS.visualizer.width;
    const height = ELEMENTS.visualizer.height;
    ctx.clearRect(0, 0, width, height);

    const bufferLength = STATE.analyserNode.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    STATE.analyserNode.getByteFrequencyData(dataArray);

    const barWidth = (width / bufferLength) * 2.08;
    let x = 0;

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#fff');
    gradient.addColorStop(1, '#ff000074');
    ctx.fillStyle = gradient;

    for (let i = 0; i < bufferLength; i++) {
      const barHeight = (dataArray[i] / 255) * height;
      ctx.fillRect(x, height - barHeight, barWidth, barHeight);
      x += barWidth + 1;
    }

    if (STATE.isRecording) {
      STATE.visualizerAnimationFrameId = requestAnimationFrame(drawVisualizer);
    }
  }

  /**
   * Updates the record button icon and text.
   */
  function updateRecordButton() {
    const icon = ELEMENTS.recordBtn.querySelector('i');
    const text = ELEMENTS.recordBtn.querySelector('span');
    if (STATE.isRecording) {
      ELEMENTS.recordBtn.classList.add('recording');
      icon.className = 'fas fa-stop';
      text.textContent = 'Stop Recording';
    } else {
      ELEMENTS.recordBtn.classList.remove('recording');
      icon.className = 'fas fa-circle';
      text.textContent = 'Start Recording';
    }
  }

  /**
   * Initiates the recording process.
   */
  async function startRecording() {
    try {
      if (STATE.isRecording) {
        console.log("[RECORDING] Recording is already active.");
        return;
      }

      STATE.activeOperations.recording = true;
      console.log("[RECORDING] Attempting to start recording.");

      const storage = await getStorageUsage();
      if (storage.count >= APP_CONFIG.MAX_RECORDINGS) {
        showAlertModal("Maximum Recordings Reached", "You have reached the maximum of 100 recordings. Please delete some recordings before creating new ones.");
        console.warn("[RECORDING] Maximum recording count reached.");
        STATE.activeOperations.recording = false;
        return;
      }
      if (storage.remaining <= 0) {
        showAlertModal("Storage Full", "You have reached the total storage limit of 74MB. Please delete some recordings before creating new ones.");
        console.warn("[RECORDING] Total storage limit reached.");
        STATE.activeOperations.recording = false;
        return;
      }
      if (storage.remaining <= APP_CONFIG.STORAGE_WARNING_THRESHOLD) {
        showAlertModal("Storage Almost Full", `You have only ${Math.round(storage.remaining / (1024 * 1024))}MB remaining. Consider deleting old recordings.`);
        console.warn("[RECORDING] Storage is almost full.");
      }
      resetPlaybackState();
      ELEMENTS.statusMessage.textContent = "Starting recording...";

      STATE.mediaStream = await captureTabAudio();
      if (STATE.audioContext.state === 'suspended') {
        await STATE.audioContext.resume();
        console.log("[AUDIO] AudioContext resumed.");
      }
      STATE.mediaStreamSource = STATE.audioContext.createMediaStreamSource(STATE.mediaStream);
      STATE.analyserNode = STATE.audioContext.createAnalyser();
      STATE.analyserNode.fftSize = 256;
      STATE.mediaStreamSource.connect(STATE.analyserNode);
      STATE.recordingChunks = [];
      STATE.mediaRecorder = new MediaRecorder(STATE.mediaStream);

      STATE.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          STATE.recordingChunks.push(event.data);
          const totalSize = STATE.recordingChunks.reduce((sum, chunk) => sum + chunk.size, 0);
          if (totalSize >= APP_CONFIG.MAX_RECORDING_SIZE) {
            console.warn("[RECORDING] Recording reached maximum size limit, stopping automatically.");
            stopRecording();
          }
        }
      };
      STATE.mediaRecorder.onerror = (event) => {
        handleError(event.error || "Recording error", "MediaRecorder");
        stopRecording();
      };

      STATE.mediaRecorder.start(100);
      STATE.isRecording = true;
      updateRecordButton();
      startVisualization();
      document.querySelector('.recording-indicator').classList.add('active');
      ELEMENTS.statusMessage.textContent = "Recording...";
      ELEMENTS.visualizerContainer.style.height = "74px";
      console.log("[RECORDING] Recording started.");
    } catch (error) {
      handleError(error, "startRecording");
      await cleanupRecordingResources();
      STATE.activeOperations.recording = false;
    }
  }

  /**
   * Stops the recording process and saves the audio.
   */
  async function stopRecording() {
    if (!STATE.isRecording) return;

    console.log("[RECORDING] Attempting to stop recording.");

    if (STATE.mediaRecorder && STATE.mediaRecorder.state !== 'inactive') {
      STATE.mediaRecorder.stop();
    }

    STATE.isRecording = false;
    updateRecordButton();
    stopVisualization();
    ELEMENTS.visualizerContainer.style.height = "0px";
    document.querySelector('.recording-indicator').classList.remove('active');
    ELEMENTS.statusMessage.textContent = "Processing recording...";

    try {
      const recordingBlob = await new Promise((resolve, reject) => {
        if (!STATE.mediaRecorder) {
          reject(new Error("MediaRecorder is not available."));
          return;
        }
        STATE.mediaRecorder.onstop = () => {
          resolve(new Blob(STATE.recordingChunks, {
            type: 'audio/webm'
          }));
        };
      });

      if (recordingBlob.size > APP_CONFIG.MAX_RECORDING_SIZE) {
        throw new Error("Recording exceeds maximum size limit (48MB)");
      }

      const recordingData = await processAudioBuffer(recordingBlob);
      if (recordingData.duration < 1400) {
        ELEMENTS.statusMessage.textContent = "Recording canceled";
        console.warn("[RECORDING] Recording was too short and was canceled.");
        await cleanupRecordingResources();
        return;
      }

      const recordingSize = (recordingData.original.length + recordingData.reversed.length) * 4;
      const storage = await getStorageUsage();
      if (storage.totalSize + recordingSize > APP_CONFIG.TOTAL_STORAGE_LIMIT) {
        throw new Error("Adding this recording would exceed total storage limit (74MB)");
      }

      const recording = {
        id: Date.now().toString(36) + Math.random().toString(36).substring(2, 9),
        createdAt: Date.now(),
        size: recordingSize,
        ...recordingData
      };

      await saveRecording(recording);
      await loadRecordings();
      updateStorageStatus();
      ELEMENTS.statusMessage.textContent = "Recording saved";
      console.log(`[RECORDING] Recording ${recording.id} saved successfully.`);
    } catch (error) {
      handleError(error, "stopRecording");
      ELEMENTS.statusMessage.textContent = "Failed to save recording: " + error.message;
    } finally {
      await cleanupRecordingResources();
      STATE.activeOperations.recording = false;
    }
  }

  /**
   * Cleans up all recording-related resources.
   */
  async function cleanupRecordingResources() {
    try {
      if (STATE.mediaRecorder && STATE.mediaRecorder.state !== 'inactive') {
        STATE.mediaRecorder.stop();
      }
      if (STATE.mediaStreamSource) {
        STATE.mediaStreamSource.disconnect();
      }
      if (STATE.mediaStream) {
        STATE.mediaStream.getTracks().forEach(track => {
          try {
            track.stop();
          } catch (e) {
            console.warn("[CLEANUP] Error stopping track:", e);
          }
        });
      }
      if (STATE.audioElement) {
        STATE.audioElement.pause();
        STATE.audioElement.srcObject = null;
        STATE.audioElement = null;
      }
      stopVisualization();
      console.log("[RECORDING] Recording resources cleaned up.");
    } catch (error) {
      console.error('[CLEANUP] Cleanup error:', error);
    } finally {
      STATE.mediaRecorder = null;
      STATE.mediaStreamSource = null;
      STATE.mediaStream = null;
      STATE.analyserNode = null;
      STATE.recordingChunks = [];
    }
  }

  /**
   * Displays the settings modal.
   */
  function showSettingsModal() {
    const existingModal = document.getElementById('settingsModal');
    if (existingModal) existingModal.remove();

    const modal = document.createElement('div');
    modal.id = 'settingsModal';
    modal.className = 'limit-alert-modal';
    modal.innerHTML = `
      <div class="modal-content">
        <h3>Settings</h3>
        <div class="settings-group">
          <label class="checkbox-container">
            Export original and reversed
            <input type="checkbox" id="exportOriginalAndReversed" ${STATE.settings.exportOriginalAndReversed ? 'checked' : ''}>
            <span class="checkmark"></span>
          </label>
        </div>
        <div class="settings-group">
          <label class="checkbox-container">
            Export with information file
            <input type="checkbox" id="exportWithInfoFile" ${STATE.settings.exportWithInfoFile ? 'checked' : ''}>
            <span class="checkmark"></span>
          </label>
        </div>
        <div class="modal-buttons">
          <button id="exportAllBtn" class="control-btn">Export All</button>
          <button id="closeSettingsBtn" class="control-btn modal-close-btn">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const exportAllBtn = document.getElementById('exportAllBtn');
    const exportOriginalAndReversedCheckbox = document.getElementById('exportOriginalAndReversed');
    const exportWithInfoFileCheckbox = document.getElementById('exportWithInfoFile');

    modal.querySelector('#closeSettingsBtn').addEventListener('click', () => modal.remove());

    exportOriginalAndReversedCheckbox.addEventListener('change', (e) => {
      STATE.settings.exportOriginalAndReversed = e.target.checked;
      saveSettings();
    });
    exportWithInfoFileCheckbox.addEventListener('change', (e) => {
      STATE.settings.exportWithInfoFile = e.target.checked;
      saveSettings();
    });

    exportAllBtn.addEventListener('click', () => {
      modal.remove();
      exportAllRecordings();
    });
  }

  /**
   * Exports all recordings, deletes them from the database, and provides them to the user.
   */
  async function exportAllRecordings() {
    try {
      const recordings = await getRecordingsFromDB();
      if (recordings.length === 0) {
        showAlertModal("No Recordings to Export", "There are no recordings to export. Please create some first.");
        return;
      }
      ELEMENTS.statusMessage.textContent = `Exporting all recordings...`;

      for (const recording of recordings) {
        const dateStr = new Date(recording.createdAt).toISOString().replace(/[:.]/g, '-');
        const exportPromises = [];

        if (STATE.settings.exportOriginalAndReversed) {
          const originalBuffer = await deserializeAudioBuffer(recording.original);
          const originalBlob = await audioBufferToWav(originalBuffer);
          exportPromises.push(downloadFile(originalBlob, `Reverse/recording_${dateStr}.wav`));

          const reversedBuffer = await deserializeAudioBuffer(recording.reversed);
          const reversedBlob = await audioBufferToWav(reversedBuffer);
          exportPromises.push(downloadFile(reversedBlob, `Reverse/recording_${dateStr}_reversed.wav`));
        } else {
          const reversedBuffer = await deserializeAudioBuffer(recording.reversed);
          const reversedBlob = await audioBufferToWav(reversedBuffer);
          exportPromises.push(downloadFile(reversedBlob, `Reverse/recording_${dateStr}.wav`));
        }

        if (STATE.settings.exportWithInfoFile) {
          const info = {
            id: recording.id,
            createdAt: recording.createdAt,
            duration: recording.duration,
            size: recording.size,
          };
          const infoBlob = new Blob([JSON.stringify(info, null, 2)], {
            type: 'application/json'
          });
          exportPromises.push(downloadFile(infoBlob, `Reverse/recording_${dateStr}_info.json`));
        }

        await Promise.all(exportPromises);

        await deleteRecordingFromDB(recording.id);
        console.log(`[EXPORT ALL] Recording ${recording.id} exported and deleted successfully.`);
      }

      ELEMENTS.statusMessage.textContent = "All recordings exported and deleted successfully.";
      await loadRecordings();
      updateStorageStatus();
      showAlertModal("Export All Complete", "All recordings have been exported and deleted from the database.");
    } catch (error) {
      handleError(error, "Export All");
      ELEMENTS.statusMessage.textContent = "Export all failed. Please check the console for details.";
    }
  }

  /**
   * Initiates a file download.
   * @param {Blob} blob - The file data as a Blob.
   * @param {string} filename - The name of the file.
   * @returns {Promise<void>}
   */
  function downloadFile(blob, filename) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => {
        URL.revokeObjectURL(url);
        resolve();
      }, 100);
    });
  }

  // Start the application
  initExtension();
});