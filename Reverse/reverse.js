window.addEventListener('DOMContentLoaded', () => {
    const APP_NAME = 'REVERSE';

    const APP_CONFIG = {
        MAX_RECORDINGS: 100,
        MAX_RECORDING_SIZE: 48 * 1024 * 1024,
        TOTAL_STORAGE_LIMIT: 74 * 1024 * 1024,
        RECORDING_WARNING_THRESHOLD_YELLOW: 28,
        RECORDING_WARNING_THRESHOLD_RED: 88,
        STORAGE_WARNING_THRESHOLD: 48 * 1024 * 1024,
        SPEED_LEVELS: [.28, .48, .74, .88, 1, 1.4, 2.08, 3.3],
        DB: { NAME: 'AudioReverserDB', VERSION: 2 },
        MIN_LOOP_DRAG_DISTANCE: 5,
        DEBOUNCE_TIMES: { RECORD: 1000, PLAYBACK: 500, EXPORT: 1000 }
    };

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
        settingsBtn: document.getElementById('settingsBtn')
    };

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
            cardElement: null,
            playbackAnimationFrameId: null,
            startOffset: 0,
            playbackRate: 1,
            loopEnabled: false
        },
        dbInstance: null,
        sortOrder: 'newest',
        allRecordings: [],
        settings: {
            exportOriginalAndReversed: false,
            exportWithInfoFile: false,
            enableHighQuality: false,
            exportAllRecordings: false
        },
        activeOperations: { recording: false, playback: false, export: false },
        debounceTimers: { record: null, playback: null, export: null },
        audioElement: null
    };

    function debounce(action, type, callback) {
        if (STATE.debounceTimers[type]) clearTimeout(STATE.debounceTimers[type]);
        if (STATE.activeOperations[type]) return;
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

    async function initExtension() {
        try {
            initTheme();
            initSettings();
            STATE.dbInstance = await openDatabase();
            STATE.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            setupVisualizer(null);
            await loadRecordings();
            updateStorageStatus();
            checkAndShowWarningModal();
            setupEventListeners();
            ELEMENTS.statusMessage.textContent = 'Ready';
        } catch (error) {
            handleError(error, 'Initialization failed. Check browser console for details.');
            ELEMENTS.statusMessage.textContent = 'Initialization failed';
        }
    }

    function openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(APP_CONFIG.DB.NAME, APP_CONFIG.DB.VERSION);
            request.onerror = (event) => reject(new Error(`Database error: ${event.target.error.message}`));
            request.onsuccess = (event) => resolve(event.target.result);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('recordings')) {
                    const store = db.createObjectStore('recordings', { keyPath: 'id' });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                }
            };
        });
    }

    async function getRecordingsFromDB() {
        return new Promise((resolve, reject) => {
            try {
                const transaction = STATE.dbInstance.transaction(['recordings'], 'readonly');
                const store = transaction.objectStore('recordings');
                const request = store.getAll();
                request.onsuccess = () => resolve(request.result);
                request.onerror = (event) => reject(new Error(`Failed to get recordings: ${event.target.error.message}`));
            } catch (error) {
                handleError(error, 'getRecordingsFromDB');
                reject(error);
            }
        });
    }

    async function saveRecording(recording) {
        return new Promise((resolve, reject) => {
            try {
                const transaction = STATE.dbInstance.transaction(['recordings'], 'readwrite');
                const store = transaction.objectStore('recordings');
                const request = store.put(recording);
                request.onsuccess = () => resolve();
                request.onerror = (event) => reject(new Error(`Failed to save recording: ${event.target.error.message}`));
            } catch (error) {
                handleError(error, 'saveRecording');
                reject(error);
            }
        });
    }

    async function updateRecordingInDB(recording) {
        return new Promise((resolve, reject) => {
            try {
                const transaction = STATE.dbInstance.transaction(['recordings'], 'readwrite');
                const store = transaction.objectStore('recordings');
                const request = store.put(recording);
                request.onsuccess = () => resolve();
                request.onerror = (event) => reject(new Error(`Failed to update recording: ${event.target.error.message}`));
            } catch (error) {
                handleError(error, 'updateRecordingInDB');
                reject(error);
            }
        });
    }

    async function deleteRecordingFromDB(id) {
        return new Promise((resolve, reject) => {
            try {
                const transaction = STATE.dbInstance.transaction(['recordings'], 'readwrite');
                const store = transaction.objectStore('recordings');
                const request = store.delete(id);
                request.onsuccess = () => resolve();
                request.onerror = (event) => reject(new Error(`Failed to delete recording: ${event.target.error.message}`));
            } catch (error) {
                handleError(error, 'deleteRecordingFromDB');
                reject(error);
            }
        });
    }

    async function captureTabAudio() {
        return new Promise((resolve, reject) => {
            chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
                if (chrome.runtime.lastError || !stream) {
                    const errorMessage = chrome.runtime.lastError?.message || 'Failed to capture tab audio';
                    reject(new Error(errorMessage));
                    return;
                }
                STATE.audioElement = new Audio();
                STATE.audioElement.srcObject = stream;
                STATE.audioElement.play().catch(e => console.error('Audio playback error:', e));
                resolve(stream);
            });
        });
    }

    async function processAudioBuffer(audioData) {
        try {
            const arrayBuffer = await audioData.arrayBuffer();
            const audioBuffer = await STATE.audioContext.decodeAudioData(arrayBuffer);
            const sampleRate = audioBuffer.sampleRate;
            const silenceSamples = sampleRate * 1;
            const newLength = audioBuffer.length + (silenceSamples * 2);
            const paddedBuffer = STATE.audioContext.createBuffer(
                audioBuffer.numberOfChannels,
                newLength,
                sampleRate
            );
            for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
                const originalData = audioBuffer.getChannelData(channel);
                const paddedData = paddedBuffer.getChannelData(channel);
                for (let i = 0; i < silenceSamples; i++) paddedData[i] = 0;
                for (let i = 0; i < originalData.length; i++) paddedData[i + silenceSamples] = originalData[i];
                for (let i = silenceSamples + originalData.length; i < newLength; i++) paddedData[i] = 0;
            }
            const reversedBuffer = STATE.audioContext.createBuffer(
                audioBuffer.numberOfChannels,
                newLength,
                sampleRate
            );
            for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
                const originalData = audioBuffer.getChannelData(channel);
                const reversedData = reversedBuffer.getChannelData(channel);
                for (let i = 0; i < silenceSamples; i++) reversedData[i] = 0;
                for (let i = 0; i < originalData.length; i++) reversedData[i + silenceSamples] = originalData[originalData.length - 1 - i];
                for (let i = silenceSamples + originalData.length; i < newLength; i++) reversedData[i] = 0;
            }
            return {
                original: Array.from(paddedBuffer.getChannelData(0)),
                reversed: Array.from(reversedBuffer.getChannelData(0)),
                duration: Math.round(paddedBuffer.duration * 1000)
            };
        } catch (error) {
            handleError(error, 'Audio Processing');
            throw new Error(`Audio processing failed: ${error.message}`);
        }
    }

    async function deserializeAudioBuffer(serialized) {
        try {
            if (!STATE.audioContext) throw new Error('AudioContext not initialized.');
            const audioBuffer = STATE.audioContext.createBuffer(1, serialized.length, STATE.audioContext.sampleRate);
            audioBuffer.getChannelData(0).set(new Float32Array(serialized));
            return audioBuffer;
        } catch (error) {
            handleError(error, 'Deserializing audio buffer');
            throw error;
        }
    }

    function stopPlayback() {
        const cp = STATE.currentPlayback;
        if (cp.sourceNode) {
            try {
                cp.sourceNode.onended = null;
                cp.sourceNode.stop();
                cp.sourceNode.disconnect();
            } catch (e) {}
            cp.sourceNode = null;
        }
        if (cp.playbackAnimationFrameId) {
            cancelAnimationFrame(cp.playbackAnimationFrameId);
            cp.playbackAnimationFrameId = null;
        }
    }

    function pausePlayback() {
        const cp = STATE.currentPlayback;
        if (cp.isPaused || !cp.sourceNode || !cp.audioBuffer) return;
        const now = STATE.audioContext.currentTime;
        const playedSinceStart = (now - cp.playbackStartTimestamp) * cp.playbackRate;
        let newPause = cp.startOffset + playedSinceStart;
        if (cp.loopEnabled && cp.loopEnd > cp.loopStart) {
            const loopLength = cp.loopEnd - cp.loopStart;
            if (loopLength > 0) {
                const relative = newPause - cp.loopStart;
                newPause = cp.loopStart + ((relative % loopLength) + loopLength) % loopLength;
            }
        }
        if (newPause < 0) newPause = 0;
        if (newPause > cp.audioBuffer.duration) newPause = cp.audioBuffer.duration;
        cp.pauseTime = newPause;
        cp.isPaused = true;
        stopPlayback();
        updatePlaybackUI();
        ELEMENTS.statusMessage.textContent = 'Paused';
    }

    async function startPlayback(recordingId, reverse = false, startTime = 0, loopStart = 0, loopEnd = 0, speed = 1) {
        stopPlayback();
        try {
            STATE.activeOperations.playback = true;
            ELEMENTS.statusMessage.textContent = 'Loading recording...';
            const recording = STATE.allRecordings.find(r => r.id === recordingId);
            if (!recording) throw new Error('Recording not found in state.');
            const card = document.querySelector(`.recording-card[data-id="${recordingId}"]`);
            const serialized = reverse ? recording.reversed : recording.original;
            const buffer = buildAudioBufferFromSerialized(serialized);
            const duration = buffer.duration || (recording.duration / 1000) || 0;
            const safeStart = Math.max(0, Math.min(startTime, duration));
            const safeLoopStart = Math.max(0, Math.min(loopStart, duration));
            const safeLoopEnd = Math.max(0, Math.min(loopEnd, duration));
            const sourceNode = STATE.audioContext.createBufferSource();
            sourceNode.buffer = buffer;
            sourceNode.playbackRate.value = speed;
            sourceNode.connect(STATE.audioContext.destination);
            const cp = STATE.currentPlayback;
            cp.id = recordingId;
            cp.sourceNode = sourceNode;
            cp.audioBuffer = buffer;
            cp.cardElement = card;
            cp.isPaused = false;
            cp.isReversed = !!reverse;
            cp.startOffset = safeStart;
            cp.pauseTime = safeStart;
            cp.loopStart = safeLoopStart;
            cp.loopEnd = safeLoopEnd;
            cp.playbackRate = speed;
            cp.loopEnabled = safeLoopEnd > safeLoopStart;
            let playbackOffsetInBuffer = safeStart;
            let srcLoopStart = safeLoopStart;
            let srcLoopEnd = safeLoopEnd;
            if (reverse) {
                playbackOffsetInBuffer = Math.max(0, buffer.duration - safeStart);
                srcLoopStart = Math.max(0, buffer.duration - safeLoopEnd);
                srcLoopEnd = Math.max(0, buffer.duration - safeLoopStart);
            }
            if (cp.loopEnabled && srcLoopEnd > srcLoopStart) {
                sourceNode.loop = true;
                sourceNode.loopStart = srcLoopStart;
                sourceNode.loopEnd = srcLoopEnd;
            } else {
                sourceNode.loop = false;
            }
            cp.playbackStartTimestamp = STATE.audioContext.currentTime;
            sourceNode.start(0, playbackOffsetInBuffer);
            sourceNode.onended = () => {
                if (STATE.currentPlayback.id === recordingId && !sourceNode.loop && !STATE.currentPlayback.isPaused) {
                    resetPlaybackState();
                }
            };
            updatePlaybackUI();
            ELEMENTS.statusMessage.textContent = reverse ? 'Playing reversed...' : 'Playing...';
        } catch (error) {
            handleError(error, 'Playback');
            resetPlaybackState();
        } finally {
            STATE.activeOperations.playback = false;
        }
    }

    function resetPlaybackState() {
        stopPlayback();
        STATE.currentPlayback = {
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
            cardElement: null,
            playbackAnimationFrameId: null,
            startOffset: 0,
            playbackRate: 1,
            loopEnabled: false
        };
        updateAllPlaybackCardUIs();
        ELEMENTS.statusMessage.textContent = 'Ready';
    }

    function togglePlayPause(recordingId) {
        const isCurrentTrack = STATE.currentPlayback.id === recordingId;
        const isPlaying = isCurrentTrack && !STATE.currentPlayback.isPaused;
        const recording = STATE.allRecordings.find(r => r.id === recordingId);
        if (!recording) return;
        if (isPlaying) {
            pausePlayback();
            return;
        }
        if (isCurrentTrack && STATE.currentPlayback.isPaused) {
            const cp = STATE.currentPlayback;
            const resumeTime = typeof cp.pauseTime === 'number' ? cp.pauseTime : 0;
            startPlayback(recordingId, cp.isReversed, resumeTime, cp.loopStart, cp.loopEnd, cp.playbackRate);
            return;
        }
        stopPlayback();
        resetPlaybackState();
        const startTime = 0;
        const loopStart = 0;
        const loopEnd = 0;
        const speed = recording.speed || 1;
        const isReversed = recording.isReversed;
        startPlayback(recordingId, isReversed, startTime, loopStart, loopEnd, speed);
    }

    async function toggleReverse(recordingId) {
        const recording = STATE.allRecordings.find(r => r.id === recordingId);
        if (!recording) return;
        recording.isReversed = !recording.isReversed;
        await updateRecordingInDB(recording);
        const card = document.querySelector(`.recording-card[data-id="${recordingId}"]`);
        if (card) {
            const reverseBtn = card.querySelector('.reverse-btn');
            if (recording.isReversed) {
                reverseBtn.classList.add('active');
            } else {
                reverseBtn.classList.remove('active');
            }
            card.classList.toggle('reversed', recording.isReversed);
        }
        const isCurrentTrack = STATE.currentPlayback.id === recordingId;
        if (isCurrentTrack) {
            const cp = STATE.currentPlayback;
            const curPause = cp.isPaused ? cp.pauseTime : (() => {
                const now = STATE.audioContext.currentTime;
                const playedSinceStart = (now - cp.playbackStartTimestamp) * cp.playbackRate;
                let newPause = cp.startOffset + playedSinceStart;
                if (cp.loopEnabled && cp.loopEnd > cp.loopStart) {
                    const loopLength = cp.loopEnd - cp.loopStart;
                    if (loopLength > 0) {
                        const relative = newPause - cp.loopStart;
                        newPause = cp.loopStart + ((relative % loopLength) + loopLength) % loopLength;
                    }
                }
                return Math.max(0, Math.min(newPause, cp.audioBuffer ? cp.audioBuffer.duration : newPause));
            })();
            const bufferDuration = cp.audioBuffer ? cp.audioBuffer.duration : (recording.duration / 1000) || 0;
            const convertedPause = bufferDuration - curPause;
            stopPlayback();
            await startPlayback(recordingId, recording.isReversed, convertedPause, cp.loopStart, cp.loopEnd, cp.playbackRate);
        } else {
            const card = document.querySelector(`.recording-card[data-id="${recordingId}"]`);
            if (card) card.classList.toggle('reversed', recording.isReversed);
        }
    }

    function updatePlaybackUI() {
        const cp = STATE.currentPlayback;
        if (!cp.id || !cp.cardElement || !cp.audioBuffer) {
            updateAllPlaybackCardUIs();
            return;
        }
        const recording = STATE.allRecordings.find(r => r.id === cp.id);
        if (!recording) return;
        const playingCard = cp.cardElement;
        const canvas = playingCard.querySelector('canvas');
        const playButton = playingCard.querySelector('.play-btn');
        const allCards = document.querySelectorAll('.recording-card');
        allCards.forEach(card => card.classList.remove('playing'));
        playingCard.classList.add('playing');
        playingCard.classList.toggle('reversed', cp.isReversed);
        updatePlayButton(playButton, !cp.isPaused);
        const drawFrame = () => {
            if (STATE.currentPlayback.isPaused || !STATE.currentPlayback.id || !STATE.currentPlayback.audioBuffer) {
                if (STATE.currentPlayback.playbackAnimationFrameId) {
                    cancelAnimationFrame(STATE.currentPlayback.playbackAnimationFrameId);
                    STATE.currentPlayback.playbackAnimationFrameId = null;
                }
                return;
            }
            const now = STATE.audioContext.currentTime;
            const playedSinceStart = (now - STATE.currentPlayback.playbackStartTimestamp) * STATE.currentPlayback.playbackRate;
            let currentTime = STATE.currentPlayback.startOffset + playedSinceStart;
            if (STATE.currentPlayback.loopEnabled && STATE.currentPlayback.loopEnd > STATE.currentPlayback.loopStart) {
                const loopDuration = STATE.currentPlayback.loopEnd - STATE.currentPlayback.loopStart;
                if (loopDuration > 0) {
                    const relative = currentTime - STATE.currentPlayback.loopStart;
                    currentTime = STATE.currentPlayback.loopStart + ((relative % loopDuration) + loopDuration) % loopDuration;
                }
            }
            if (currentTime < 0) currentTime = 0;
            if (currentTime > STATE.currentPlayback.audioBuffer.duration) currentTime = STATE.currentPlayback.audioBuffer.duration;
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
        if (!cp.isPaused) {
            if (cp.playbackAnimationFrameId) cancelAnimationFrame(cp.playbackAnimationFrameId);
            cp.playbackAnimationFrameId = requestAnimationFrame(drawFrame);
        } else {
            const displayedTime = cp.isReversed && cp.audioBuffer ? cp.audioBuffer.duration - cp.pauseTime : cp.pauseTime;
            drawWaveform(
                cp.audioBuffer,
                canvas,
                displayedTime,
                cp.loopStart,
                cp.loopEnd,
                cp.isReversed
            );
        }
    }

    function updateAllPlaybackCardUIs() {
        document.querySelectorAll('.recording-card').forEach(card => {
            card.classList.remove('playing');
            card.classList.remove('reversed');
            const playBtn = card.querySelector('.play-btn');
            if (playBtn) updatePlayButton(playBtn, false);
            const speedDisplay = card.querySelector('.speed-display');
            const id = card.dataset.id;
            const rec = STATE.allRecordings.find(r => r.id === id);
            if (speedDisplay && rec) speedDisplay.textContent = `${(rec.speed || 1).toFixed(2)}x`;
        });
        document.querySelectorAll('.playback-bar').forEach(bar => bar.style.width = '0%');
    }

    async function updatePlaybackSpeed(recordingId, newSpeedIndex) {
        const newSpeed = APP_CONFIG.SPEED_LEVELS[newSpeedIndex];
        const recording = STATE.allRecordings.find(r => r.id === recordingId);
        if (!recording) return;
        recording.speed = newSpeed;
        await updateRecordingInDB(recording);
        const card = document.querySelector(`.recording-card[data-id="${recordingId}"]`);
        if (card) card.querySelector('.speed-display').textContent = `${newSpeed.toFixed(2)}x`;
        if (STATE.currentPlayback.id === recordingId) {
            const cp = STATE.currentPlayback;
            const wasPaused = cp.isPaused;
            const resumePoint = wasPaused ? cp.pauseTime : (() => {
                const now = STATE.audioContext.currentTime;
                const playedSinceStart = (now - cp.playbackStartTimestamp) * cp.playbackRate;
                let newPause = cp.startOffset + playedSinceStart;
                if (cp.loopEnabled && cp.loopEnd > cp.loopStart) {
                    const loopLength = cp.loopEnd - cp.loopStart;
                    if (loopLength > 0) {
                        const relative = newPause - cp.loopStart;
                        newPause = cp.loopStart + ((relative % loopLength) + loopLength) % loopLength;
                    }
                }
                return Math.max(0, Math.min(newPause, cp.audioBuffer ? cp.audioBuffer.duration : newPause));
            })();
            stopPlayback();
            await startPlayback(
                recordingId,
                cp.isReversed,
                resumePoint,
                cp.loopStart,
                cp.loopEnd,
                newSpeed
            );
            if (wasPaused) pausePlayback();
        }
    }

    function drawWaveform(buffer, canvas, currentTime = -1, loopStart = -1, loopEnd = -1, isReversed = false, dragLoopStart = -1, dragLoopEnd = -1) {
        if (!buffer || !canvas) return;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        canvas.width = canvas.offsetWidth * dpr;
        canvas.height = canvas.offsetHeight * dpr;
        const width = canvas.width;
        const height = canvas.height;
        ctx.clearRect(0, 0, width, height);
        const data = buffer.getChannelData(0);
        const step = Math.ceil(data.length / width);
        const amp = height / 2;
        const waveformFillColor = getComputedStyle(document.documentElement).getPropertyValue('--waveform-fill').trim();
        const waveformStrokeColor = getComputedStyle(document.documentElement).getPropertyValue('--waveform-stroke').trim();
        const waveformDragOverlay = getComputedStyle(document.documentElement).getPropertyValue('--waveform-drag-overlay').trim();
        ctx.fillStyle = waveformFillColor;
        ctx.beginPath();
        ctx.moveTo(0, amp);
        for (let i = 0; i < width; i++) {
            let min = 1.0;
            let max = -1.0;
            for (let j = 0; j < step; j++) {
                const idx = Math.min(data.length - 1, (i * step) + j);
                const datum = data[idx];
                if (datum < min) min = datum;
                if (datum > max) max = datum;
            }
            ctx.lineTo(i, (1 + max) * amp);
        }
        for (let i = width - 1; i >= 0; i--) {
            let min = 1.0;
            for (let j = 0; j < step; j++) {
                const idx = Math.min(data.length - 1, (i * step) + j);
                const datum = data[idx];
                if (datum < min) min = datum;
            }
            ctx.lineTo(i, (1 + min) * amp);
        }
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = waveformStrokeColor;
        ctx.shadowBlur = 10;
        ctx.shadowColor = waveformStrokeColor;
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        ctx.moveTo(0, amp);
        for (let i = 0; i < width; i++) {
            let max = -1.0;
            for (let j = 0; j < step; j++) {
                const idx = Math.min(data.length - 1, (i * step) + j);
                const datum = data[idx];
                if (datum > max) max = datum;
            }
            ctx.lineTo(i, (1 + max) * amp);
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
        if (loopEnd > loopStart) {
            const totalDuration = buffer.duration;
            const displayLoopStart = isReversed ? totalDuration - loopEnd : loopStart;
            const displayLoopEnd = isReversed ? totalDuration - loopStart : loopEnd;
            const margin = width * 0.05;
            const startX = Math.max(margin, (displayLoopStart / totalDuration) * width);
            const endX = Math.min(width - margin, (displayLoopEnd / totalDuration) * width);
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
            const margin = width * 0.05;
            const startX = Math.max(margin, (dragLoopStart / totalDuration) * width);
            const endX = Math.min(width - margin, (dragLoopEnd / totalDuration) * width);
            ctx.fillStyle = waveformDragOverlay;
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
            const totalDuration = buffer.duration;
            const margin = width * 0.05;
            const playX = Math.max(margin, Math.min(width - margin, (currentTime / totalDuration) * width));
            ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--waveform-progress').trim();
            ctx.lineWidth = 2 * dpr;
            ctx.beginPath();
            ctx.moveTo(playX, 0);
            ctx.lineTo(playX, height);
            ctx.stroke();
        }
    }

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
        if (recording.isReversed) reverseBtn.classList.add('active');
        speedDisplay.textContent = `${(recording.speed || 1).toFixed(2)}x`;
        card.classList.toggle('reversed', recording.isReversed);
        updatePlayButton(playBtn, false);
        let waveformBuffer = null;
        deserializeAudioBuffer(recording.original)
            .then(buffer => {
                waveformBuffer = buffer;
                drawWaveform(waveformBuffer, waveformCanvas);
            })
            .catch(err => console.error('Waveform error:', err));
        let isDragging = false;
        let dragStartX = 0;
        let dragEndX = 0;
        waveformCanvas.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            if (!waveformBuffer) return;
            stopPlayback();
            resetPlaybackState();
            isDragging = true;
            dragStartX = e.offsetX;
            dragEndX = e.offsetX;
            waveformCanvas.setPointerCapture(e.pointerId);
        });
        waveformCanvas.addEventListener('pointermove', (e) => {
            if (!isDragging || !waveformBuffer) return;
            e.preventDefault();
            dragEndX = e.offsetX;
            const canvasWidth = waveformCanvas.offsetWidth;
            const totalDuration = waveformBuffer.duration;
            const margin = canvasWidth * 0.05;
            const constrainedStartX = Math.max(margin, Math.min(canvasWidth - margin, Math.min(dragStartX, dragEndX)));
            const constrainedEndX = Math.max(margin, Math.min(canvasWidth - margin, Math.max(dragStartX, dragEndX)));
            const dragLoopStart = (constrainedStartX / canvasWidth) * totalDuration;
            const dragLoopEnd = (constrainedEndX / canvasWidth) * totalDuration;
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
        waveformCanvas.addEventListener('pointerup', (e) => {
            if (!isDragging || !waveformBuffer) return;
            e.preventDefault();
            isDragging = false;
            const canvasWidth = waveformCanvas.offsetWidth;
            const totalDuration = waveformBuffer.duration;
            const finalX = e.offsetX;
            const margin = canvasWidth * 0.05;
            const constrainedStartX = Math.max(margin, Math.min(canvasWidth - margin, Math.min(dragStartX, finalX)));
            const constrainedEndX = Math.max(margin, Math.min(canvasWidth - margin, Math.max(dragStartX, finalX)));
            const startX = constrainedStartX;
            const endX = constrainedEndX;
            const recordingToPlay = STATE.allRecordings.find(r => r.id === recording.id);
            if (!recordingToPlay) return;
            if (Math.abs(dragStartX - finalX) < APP_CONFIG.MIN_LOOP_DRAG_DISTANCE) {
                const seekTime = (constrainedEndX / canvasWidth) * totalDuration;
                setTimeout(() => {
                    startPlayback(recording.id, recordingToPlay.isReversed, seekTime, 0, 0, recordingToPlay.speed);
                }, 74);
            } else {
                const newLoopStart = (startX / canvasWidth) * totalDuration;
                const newLoopEnd = (endX / canvasWidth) * totalDuration;
                setTimeout(() => {
                    startPlayback(recording.id, recordingToPlay.isReversed, newLoopStart, newLoopStart, newLoopEnd, recordingToPlay.speed);
                }, 48);
            }
            drawWaveform(waveformBuffer, waveformCanvas);
        });
        waveformCanvas.addEventListener('pointerleave', (e) => {
            if (!isDragging || !waveformBuffer) return;
            e.preventDefault();
            isDragging = false;
            const canvasWidth = waveformCanvas.offsetWidth;
            const totalDuration = waveformBuffer.duration;
            const margin = canvasWidth * 0.05;
            const finalX = e.offsetX < 0 ? margin : (e.offsetX > canvasWidth ? canvasWidth - margin :
                Math.max(margin, Math.min(canvasWidth - margin, e.offsetX)));
            const constrainedStartX = Math.max(margin, Math.min(canvasWidth - margin, Math.min(dragStartX, finalX)));
            const constrainedEndX = Math.max(margin, Math.min(canvasWidth - margin, Math.max(dragStartX, finalX)));
            const startX = constrainedStartX;
            const endX = constrainedEndX;
            const recordingToPlay = STATE.allRecordings.find(r => r.id === recording.id);
            if (!recordingToPlay) return;
            if (Math.abs(dragStartX - finalX) < APP_CONFIG.MIN_LOOP_DRAG_DISTANCE) {
                const seekTime = (constrainedEndX / canvasWidth) * totalDuration;
                setTimeout(() => {
                    startPlayback(recording.id, recordingToPlay.isReversed, seekTime, 0, 0, recordingToPlay.speed);
                }, 74);
            } else {
                const newLoopStart = (startX / canvasWidth) * totalDuration;
                const newLoopEnd = (endX / canvasWidth) * totalDuration;
                setTimeout(() => {
                    startPlayback(recording.id, recordingToPlay.isReversed, newLoopStart, newLoopStart, newLoopEnd, recordingToPlay.speed);
                }, 48);
            }
            drawWaveform(waveformBuffer, waveformCanvas);
        });
        playBtn.addEventListener('click', () => {
            debounce('togglePlayPause', 'playback', async () => {
                togglePlayPause(recording.id);
            });
        });
        reverseBtn.addEventListener('click', () => {
            debounce('toggleReverse', 'playback', async () => {
                await toggleReverse(recording.id);
            });
        });
        deleteBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to delete this recording?')) {
                deleteRecording(recording.id);
            }
        });
        exportBtn.addEventListener('click', () => {
            debounce('exportRecording', 'export', async () => {
                await exportRecording(recording.id);
            });
        });
        speedUpBtn.addEventListener('click', () => {
            const currentSpeedIndex = APP_CONFIG.SPEED_LEVELS.indexOf(recording.speed);
            if (currentSpeedIndex < APP_CONFIG.SPEED_LEVELS.length - 1) {
                const newSpeedIndex = currentSpeedIndex + 1;
                updatePlaybackSpeed(recording.id, newSpeedIndex);
            }
        });
        speedDownBtn.addEventListener('click', () => {
            const currentSpeedIndex = APP_CONFIG.SPEED_LEVELS.indexOf(recording.speed);
            if (currentSpeedIndex > 0) {
                const newSpeedIndex = currentSpeedIndex - 1;
                updatePlaybackSpeed(recording.id, newSpeedIndex);
            }
        });
        return card;
    }

    async function loadRecordings() {
        try {
            const recordings = await getRecordingsFromDB();
            STATE.allRecordings = recordings.sort((a, b) => (STATE.sortOrder === 'oldest' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
            ELEMENTS.recordingsGrid.innerHTML = '';
            STATE.allRecordings.forEach(recording => {
                const card = createRecordingCard(recording);
                ELEMENTS.recordingsGrid.appendChild(card);
            });
            updateStorageStatus();
            ELEMENTS.statusMessage.textContent = `${recordings.length} recordings loaded.`;
        } catch (error) {
            handleError(error, 'Failed to load recordings');
            ELEMENTS.statusMessage.textContent = 'Failed to load recordings.';
        }
    }

    async function deleteRecording(recordingId) {
        try {
            if (STATE.currentPlayback.id === recordingId) {
                stopPlayback();
                resetPlaybackState();
            }
            await deleteRecordingFromDB(recordingId);
            STATE.allRecordings = STATE.allRecordings.filter(r => r.id !== recordingId);
            const card = document.querySelector(`.recording-card[data-id="${recordingId}"]`);
            if (card) card.remove();
            updateStorageStatus();
            ELEMENTS.statusMessage.textContent = 'Recording deleted.';
        } catch (error) {
            handleError(error, 'Failed to delete recording');
        }
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function buildAudioBufferFromSerialized(serialized) {
        if (!STATE.audioContext) throw new Error('AudioContext not initialized.');
        if (!serialized) throw new Error('No serialized audio passed.');
        const sampleRate = STATE.audioContext.sampleRate;
        if (Array.isArray(serialized[0])) {
            const numChannels = serialized.length;
            const length = serialized[0].length;
            const audioBuffer = STATE.audioContext.createBuffer(numChannels, length, sampleRate);
            for (let ch = 0; ch < numChannels; ch++) {
                audioBuffer.getChannelData(ch).set(new Float32Array(serialized[ch]));
            }
            return audioBuffer;
        }
        const length = serialized.length;
        const audioBuffer = STATE.audioContext.createBuffer(1, length, sampleRate);
        audioBuffer.getChannelData(0).set(new Float32Array(serialized));
        return audioBuffer;
    }

    function extractAudioSegment(buffer, startSec, endSec) {
        if (!buffer) throw new Error('extractAudioSegment: buffer required.');
        const sr = buffer.sampleRate;
        const startFrame = Math.max(0, Math.floor(startSec * sr));
        const endFrame = Math.min(buffer.length, Math.floor(endSec * sr));
        const newLength = Math.max(0, endFrame - startFrame);
        const out = STATE.audioContext.createBuffer(buffer.numberOfChannels, newLength, sr);
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const src = buffer.getChannelData(ch).subarray(startFrame, endFrame);
            out.getChannelData(ch).set(src);
        }
        return out;
    }

    async function resampleWithOffline(sourceBuffer, speed = 1) {
        if (!STATE.audioContext) throw new Error('AudioContext not initialized.');
        if (!sourceBuffer) throw new Error('resampleWithOffline: sourceBuffer required.');
        if (Math.abs(speed - 1) < 1e-9) return sourceBuffer;
        const numChannels = sourceBuffer.numberOfChannels;
        const sampleRate = sourceBuffer.sampleRate;
        const targetDuration = sourceBuffer.duration / speed;
        const targetLength = Math.max(1, Math.ceil(targetDuration * sampleRate));
        const offline = new OfflineAudioContext(numChannels, targetLength, sampleRate);
        const src = offline.createBufferSource();
        src.buffer = sourceBuffer;
        src.playbackRate.value = speed;
        src.connect(offline.destination);
        src.start(0);
        const rendered = await offline.startRendering();
        return rendered;
    }

    async function getProcessedAudioBuffer(recording) {
        if (!recording) throw new Error('recording required.');
        const serialized = recording.isReversed ? recording.reversed : recording.original;
        let buffer = buildAudioBufferFromSerialized(serialized);
        if (STATE.currentPlayback.id === recording.id && STATE.currentPlayback.loopEnd > STATE.currentPlayback.loopStart) {
            buffer = extractAudioSegment(buffer, STATE.currentPlayback.loopStart, STATE.currentPlayback.loopEnd);
        }
        const speed = typeof recording.speed === 'number' ? recording.speed : 1;
        if (Math.abs(speed - 1) > 1e-9) {
            buffer = await resampleWithOffline(buffer, speed);
        }
        return buffer;
    }

    async function exportRecording(recordingId) {
        try {
            ELEMENTS.statusMessage.textContent = 'Preparing export...';
            const recording = STATE.allRecordings.find(r => r.id === recordingId);
            if (!recording) throw new Error('Recording not found.');
            const variants = [];
            if (STATE.settings.exportOriginalAndReversed) {
                variants.push({ label: 'original', isReversed: false });
                variants.push({ label: 'reversed', isReversed: true });
            } else {
                variants.push({ label: recording.isReversed ? 'reversed' : 'original', isReversed: !!recording.isReversed });
            }
            for (const v of variants) {
                const recVariant = { ...recording, isReversed: v.isReversed };
                ELEMENTS.statusMessage.textContent = `Rendering ${v.label}...`;
                const processedBuffer = await getProcessedAudioBuffer(recVariant);
                ELEMENTS.statusMessage.textContent = `Encoding ${v.label} to WAV...`;
                const wavBlob = convertAudioBufferToWavBlob(processedBuffer);
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const baseName = `recording_${recording.id}_${v.label}_${timestamp}.wav`;
                downloadBlob(wavBlob, baseName);
                await new Promise(r => setTimeout(r, 120));
            }
            if (STATE.settings.exportWithInfoFile) {
                const metadata = {
                    id: recording.id,
                    createdAt: recording.createdAt,
                    durationMs: recording.duration,
                    exportedAt: Date.now(),
                    exportedVariants: variants.map(v => v.label),
                    channels: (() => {
                        const s = recording.original;
                        if (Array.isArray(s[0])) return s.length;
                        return 1;
                    })(),
                    sampleRate: STATE.audioContext ? STATE.audioContext.sampleRate : null,
                    speed: recording.speed,
                    isReversed: recording.isReversed
                };
                const jsonBlob = new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' });
                downloadBlob(jsonBlob, `recording_${recording.id}_info.json`);
            }
            ELEMENTS.statusMessage.textContent = 'Export complete.';
        } catch (error) {
            handleError(error, 'Export failed');
        } finally {
            STATE.activeOperations.export = false;
        }
    }

    async function exportAllRecordings() {
        try {
            ELEMENTS.statusMessage.textContent = 'Starting mass export...';
            for (const recording of STATE.allRecordings) {
                const processedBuffer = buildAudioBufferFromSerialized(recording.original);
                const wavBlob = convertAudioBufferToWavBlob(processedBuffer);
                const timestamp = new Date(recording.createdAt).toISOString().replace(/[:.]/g, '-');
                const filename = `recording_${recording.id}_original_${timestamp}.wav`;
                downloadBlob(wavBlob, filename);
                await new Promise(r => setTimeout(r, 100));
            }
            ELEMENTS.statusMessage.textContent = `Exported ${STATE.allRecordings.length} recordings.`;
        } catch (error) {
            handleError(error, 'Mass export failed');
        } finally {
            STATE.activeOperations.export = false;
        }
    }


    function convertAudioBufferToWavBlob(buffer) {
        if (!buffer) throw new Error('convertAudioBufferToWavBlob: AudioBuffer required.');
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const bitsPerSample = 32;
        const bytesPerSample = bitsPerSample / 8;
        const blockAlign = numChannels * bytesPerSample;
        const dataByteLength = buffer.length * blockAlign;
        const headerByteLength = 44;
        const totalLength = headerByteLength + dataByteLength;
        const arrayBuffer = new ArrayBuffer(totalLength);
        const view = new DataView(arrayBuffer);
        function writeString(view, offset, string) {
            for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i));
        }
        writeString(view, 0, 'RIFF');
        view.setUint32(4, 36 + dataByteLength, true);
        writeString(view, 8, 'WAVE');
        writeString(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 3, true);
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * blockAlign, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);
        writeString(view, 36, 'data');
        view.setUint32(40, dataByteLength, true);
        let offset = 44;
        const channels = new Array(numChannels);
        for (let ch = 0; ch < numChannels; ch++) channels[ch] = buffer.getChannelData(ch);
        for (let i = 0; i < buffer.length; i++) {
            for (let ch = 0; ch < numChannels; ch++) {
                view.setFloat32(offset, channels[ch][i], true);
                offset += 4;
            }
        }
        return new Blob([view], { type: 'audio/wav' });
    }

    async function startRecording() {
        if (STATE.isRecording) return;
        if (STATE.allRecordings.length >= APP_CONFIG.MAX_RECORDINGS - 1) {
            showModal('Recording Limit Reached', 'You have reached the maximum number of recordings. Please delete some old recordings to free up space.');
            return;
        }
        ELEMENTS.statusMessage.textContent = 'Starting to record...';
        try {
            STATE.isRecording = true;
            STATE.recordingChunks = [];
            STATE.mediaStream = await captureTabAudio();
            STATE.mediaRecorder = new MediaRecorder(STATE.mediaStream);
            STATE.mediaRecorder.ondataavailable = (event) => {
                STATE.recordingChunks.push(event.data);
            };
            STATE.mediaRecorder.onstop = async () => {
                if (STATE.recordingChunks.length > 0) {
                    ELEMENTS.statusMessage.textContent = 'Saving recording...';
                    const audioBlob = new Blob(STATE.recordingChunks, { type: 'audio/webm; codecs=opus' });
                    const processedAudio = await processAudioBuffer(audioBlob);
                    const newRecording = {
                        id: 'rec-' + Date.now(),
                        createdAt: Date.now(),
                        duration: processedAudio.duration,
                        original: processedAudio.original,
                        reversed: processedAudio.reversed,
                        isReversed: false,
                        speed: 1
                    };
                    await saveRecording(newRecording);
                    STATE.allRecordings.unshift(newRecording);
                    const newCard = createRecordingCard(newRecording);
                    ELEMENTS.recordingsGrid.prepend(newCard);
                    updateStorageStatus();
                    ELEMENTS.statusMessage.textContent = 'Recording saved.';
                } else {
                    ELEMENTS.statusMessage.textContent = 'Recording aborted. No data.';
                }
                resetRecordingState();
            };
            STATE.mediaRecorder.start();
            setupVisualizer(STATE.mediaStream);
            const labelSpan = ELEMENTS.recordBtn.querySelector('span');
            labelSpan.textContent = 'Stop Recording';
            ELEMENTS.recordBtn.classList.add('recording');
            ELEMENTS.statusMessage.textContent = 'Recording...';
        } catch (error) {
            handleError(error, 'Recording failed');
            resetRecordingState();
        }
    }

    function stopRecording() {
        if (!STATE.isRecording) return;
        STATE.isRecording = false;
        if (STATE.mediaRecorder && STATE.mediaRecorder.state !== 'inactive') {
            STATE.mediaRecorder.stop();
        }
    }

    function resetRecordingState() {
        STATE.isRecording = false;
        if (STATE.mediaStream) {
            STATE.mediaStream.getTracks().forEach(track => track.stop());
            STATE.mediaStream = null;
        }
        STATE.recordingChunks = [];
        if (STATE.audioElement) {
            STATE.audioElement.srcObject = null;
            STATE.audioElement = null;
        }
        setupVisualizer(null);
        ELEMENTS.recordBtn.querySelector('span').textContent = 'Start Recording';
        ELEMENTS.recordBtn.classList.remove('recording');
    }

    function setupVisualizer(stream) {
        if (!stream) {
            if (STATE.visualizerAnimationFrameId) {
                cancelAnimationFrame(STATE.visualizerAnimationFrameId);
                STATE.visualizerAnimationFrameId = null;
            }
            if (STATE.mediaStreamSource) {
                STATE.mediaStreamSource.disconnect();
                STATE.mediaStreamSource = null;
            }
            if (STATE.analyserNode) {
                STATE.analyserNode.disconnect();
                STATE.analyserNode = null;
            }
            const ctx = ELEMENTS.visualizer.getContext('2d');
            ctx.clearRect(0, 0, ELEMENTS.visualizer.width, ELEMENTS.visualizer.height);
            return;
        }
        if (!STATE.audioContext) {
            try {
                STATE.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            } catch (e) {
                handleError(e, 'AudioContext setup');
                return;
            }
        }
        STATE.mediaStreamSource = STATE.audioContext.createMediaStreamSource(stream);
        STATE.analyserNode = STATE.audioContext.createAnalyser();
        STATE.analyserNode.fftSize = 256;
        STATE.mediaStreamSource.connect(STATE.analyserNode);
        const dataArray = new Uint8Array(STATE.analyserNode.frequencyBinCount);
        const draw = () => {
            STATE.analyserNode.getByteFrequencyData(dataArray);
            const ctx = ELEMENTS.visualizer.getContext('2d');
            const width = ELEMENTS.visualizer.width;
            const height = ELEMENTS.visualizer.height;
            const barWidth = (width / dataArray.length) * 2.5;
            let x = 0;
            ctx.clearRect(0, 0, width, height);
            ctx.fillStyle = '#fff';
            for (let i = 0; i < dataArray.length; i++) {
                const barHeight = dataArray[i] / 2;
                ctx.fillRect(x, height - barHeight, barWidth, barHeight);
                x += barWidth + 1;
            }
            STATE.visualizerAnimationFrameId = requestAnimationFrame(draw);
        };
        draw();
    }

    function initTheme() {
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            document.documentElement.classList.remove('theme-light');
        } else {
            document.documentElement.classList.add('theme-light');
        }
    }

    async function initSettings() {}

    async function updateStorageStatus() {
        if (!navigator.storage || !navigator.storage.estimate) {
            ELEMENTS.storageStatus.style.display = 'none';
            return;
        }
        try {
            const numRecordings = STATE.allRecordings.length;
            const isYellowWarning = numRecordings >= APP_CONFIG.RECORDING_WARNING_THRESHOLD_YELLOW;
            const isRedWarning = numRecordings >= APP_CONFIG.RECORDING_WARNING_THRESHOLD_RED;
            ELEMENTS.storageStatus.textContent = `Used: ${numRecordings}/${APP_CONFIG.MAX_RECORDINGS} recordings`;
            ELEMENTS.storageStatus.classList.toggle('warning-yellow', isYellowWarning && !isRedWarning);
            ELEMENTS.storageStatus.classList.toggle('warning-red', isRedWarning);
            ELEMENTS.storageStatus.style.display = 'block';
        } catch (e) {
            handleError(e, 'Storage status update');
        }
    }

    async function checkAndShowWarningModal() {
        if (!navigator.storage || !navigator.storage.estimate) return;
        try {
            const estimate = await navigator.storage.estimate();
            const usage = estimate.usage;
            if (usage >= APP_CONFIG.STORAGE_WARNING_THRESHOLD) {
                const usageMB = (usage / (1024 * 1024)).toFixed(2);
                const quotaMB = (estimate.quota / (1024 * 1024)).toFixed(2);
                const message = `You're running low on storage space. Used: ${usageMB} MB / ${quotaMB} MB. Please consider deleting some recordings.`;
                showModal('Low Storage Warning', message);
            }
        } catch (e) {
            console.error('Failed to check storage for warning modal:', e);
        }
    }

    function showModal(title, message) {
        const modalId = 'dynamicModal';
        let modal = document.getElementById(modalId);
        if (!modal) {
            modal = document.createElement('div');
            modal.id = modalId;
            modal.classList.add('modal');
            modal.innerHTML = `
                <div class="modal-content">
                    <span class="close-btn">&times;</span>
                    <h3 id="modal-title"></h3>
                    <p id="modal-message"></p>
                </div>
            `;
            document.body.appendChild(modal);
            modal.querySelector('.close-btn').addEventListener('click', () => modal.style.display = 'none');
            window.addEventListener('click', (event) => {
                if (event.target === modal) modal.style.display = 'none';
            });
        }
        modal.querySelector('#modal-title').textContent = title;
        modal.querySelector('#modal-message').textContent = message;
        modal.style.display = 'block';
    }


    function setupEventListeners() {
        ELEMENTS.recordBtn.addEventListener('click', () => {
            if (STATE.isRecording) {
                stopRecording();
            } else {
                debounce('startRecording', 'record', async () => {
                    await startRecording();
                });
            }
        });
        ELEMENTS.themeToggle.addEventListener('click', () => {
            document.documentElement.classList.toggle('theme-dark');
            document.documentElement.classList.toggle('theme-light');
        });
        ELEMENTS.sortSelect.addEventListener('change', (e) => {
            STATE.sortOrder = e.target.value;
            loadRecordings();
        });
        const settingsModalBtn = document.getElementById('settingsModalBtn');
        const settingsModal = document.getElementById('settingsModal');
        const closeSettingsBtn = document.querySelector('#settingsModal .close-btn');

        closeSettingsBtn.addEventListener('click', () => {
            settingsModal.style.display = 'none';
        });

    }

    function formatDuration(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    }

    function handleError(error, context) {
        console.error(`Error in ${context}:`, error);
        ELEMENTS.statusMessage.textContent = `Error: ${error.message}`;
        updateAllPlaybackCardUIs();
    }

    initExtension();
});