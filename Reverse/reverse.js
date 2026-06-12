/**
 * @fileoverview Reverse Audio Application Core - Enhanced UI Release Engine
 * Features ProWaveformEngine upgraded with dynamic view collapses, 
 * glassmorphism cozy overlay binding, operational status locking, and localized dictionary trees.
 */

window.addEventListener('DOMContentLoaded', () => {
    const APP_NAME = 'REVERSE';

    const APP_CONFIG = {
        MAX_RECORDINGS: 20,
        MAX_RECORDING_SIZE: 48 * 1024 * 1024,
        TOTAL_STORAGE_LIMIT: 74 * 1024 * 1024,
        RECORDING_WARNING_THRESHOLD_YELLOW: 10,
        RECORDING_WARNING_THRESHOLD_RED: 18,
        STORAGE_WARNING_THRESHOLD: 48 * 1024 * 1024,
        SPEED_LEVELS: [.28, .48, .74, .88, 1, 1.4, 2.08, 3.3],
        DB: { NAME: 'AudioReverserDB', VERSION: 3 },
        MIN_LOOP_DRAG_DISTANCE: 4,
        DEBOUNCE_TIMES: { RECORD: 300, PLAYBACK: 150, EXPORT: 500 },
        ZOOM: {
            MIN_WINDOW_DURATION: 0.05,
            SENSITIVITY: 0.12,
            LERP_FACTOR: 0.22
        }
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
        settingsModalBtn: document.getElementById('settingsBtn'),
        settingsModal: document.getElementById('settingsModal'),
        closeSettingsBtn: document.querySelector('#settingsModal .close-btn'),
        recorderPanel: document.getElementById('recorderPanel'),
        togglePanelBtn: document.getElementById('togglePanelBtn'),
        langSelect: document.getElementById('langSelect'),
        clearAllRecordingsBtn: document.getElementById('clearAllRecordingsBtn'),
        infoModal: document.getElementById('infoModal'),
        infoModalTitle: document.getElementById('infoModalTitle'),
        infoModalMessage: document.getElementById('infoModalMessage'),
        infoModalOkBtn: document.getElementById('infoModalOkBtn'),
        infoModalCloseBtn: document.querySelector('#infoModal .close-btn')
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
        cachedPeaks: {},      
        viewStates: {},       
        activeOperations: { recording: false, playback: false, export: false },
        debounceTimers: { record: null, playback: null, export: null },
        audioElement: null,
        currentLanguage: 'en'
    };

    /**
     * Micro Localization Engine
     */
    const I18N = {
        dict: {},
        async init() {
            try {
                const res = await fetch('strings.json');
                this.dict = await res.json();
                this.translateDOM(document);
            } catch (err) {
                console.error("Localization engine failed to bind dictionary streams", err);
            }
        },
        get(key, replacements = {}) {
            let value = this.dict[key] || key;
            Object.keys(replacements).forEach(k => {
                value = value.replace(`{${k}}`, replacements[k]);
            });
            return value;
        },
        translateDOM(rootContext) {
            rootContext.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if (this.dict[key]) el.textContent = this.dict[key];
            });
            rootContext.querySelectorAll('[data-i18n-title]').forEach(el => {
                const key = el.getAttribute('data-i18n-title');
                if (this.dict[key]) el.setAttribute('title', this.dict[key]);
            });
            rootContext.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
                const key = el.getAttribute('data-i18n-aria-label');
                if (this.dict[key]) el.setAttribute('aria-label', this.dict[key]);
            });
        }
    };

    /**
     * ProWaveformEngine - Advanced DSP Sub-pixel Vector Rendering Matrix
     */
    const ProWaveformEngine = {
        generateCache(recordingId, buffer, blockSize = 32) {
            const numChannels = buffer.numberOfChannels;
            const len = buffer.length;
            const numBlocks = Math.ceil(len / blockSize);
            const maxPeaks = new Float32Array(numBlocks);
            const minPeaks = new Float32Array(numBlocks);

            const channels = [];
            for (let ch = 0; ch < numChannels; ch++) {
                channels.push(buffer.getChannelData(ch));
            }

            for (let i = 0; i < numBlocks; i++) {
                const start = i * blockSize;
                const end = Math.min(start + blockSize, len);
                let max = 0;
                let min = 0;

                for (let j = start; j < end; j++) {
                    for (let ch = 0; ch < numChannels; ch++) {
                        const val = channels[ch][j];
                        if (val > max) max = val;
                        if (val < min) min = val;
                    }
                }
                maxPeaks[i] = max;
                minPeaks[i] = min;
            }

            STATE.cachedPeaks[recordingId] = {
                maxPeaks,
                minPeaks,
                blockSize,
                totalSamples: len,
                duration: buffer.duration
            };
        },

        render(recordingId, canvas, viewStartSec, viewEndSec, playheadSec, dragStartSec = -1, dragEndSec = -1, loopStartSec = 0, loopEndSec = 0) {
            if (!canvas) return;
            const cache = STATE.cachedPeaks[recordingId];
            if (!cache) return;

            const ctx = canvas.getContext('2d');
            const dpr = window.devicePixelRatio || 1;
            const rectWidth = canvas.offsetWidth;
            const rectHeight = canvas.offsetHeight;

            if (canvas.width !== rectWidth * dpr || canvas.height !== rectHeight * dpr) {
                canvas.width = rectWidth * dpr;
                canvas.height = rectHeight * dpr;
            }

            ctx.save();
            ctx.scale(dpr, dpr);
            ctx.clearRect(0, 0, rectWidth, rectHeight);

            const centerY = rectHeight / 2;
            const ampHeight = rectHeight * 0.42;
            const totalDuration = cache.duration;
            const viewDuration = viewEndSec - viewStartSec;

            if (viewDuration <= 0) {
                ctx.restore();
                return;
            }

            const topPoints = new Float32Array(rectWidth);
            const bottomPoints = new Float32Array(rectWidth);

            for (let col = 0; col < rectWidth; col++) {
                const fracSampleStart = ((viewStartSec + (col / rectWidth) * viewDuration) / totalDuration) * cache.totalSamples;
                const fracSampleEnd = ((viewStartSec + ((col + 1) / rectWidth) * viewDuration) / totalDuration) * cache.totalSamples;

                const cacheIdxStart = fracSampleStart / cache.blockSize;
                const cacheIdxEnd = fracSampleEnd / cache.blockSize;

                let maxVal = 0.005;
                let minVal = -0.005;

                if (cacheIdxEnd - cacheIdxStart < 1.0) {
                    const baseIdx = Math.floor(cacheIdxStart);
                    const nextIdx = Math.min(baseIdx + 1, cache.maxPeaks.length - 1);
                    const weight = cacheIdxStart - baseIdx;

                    if (baseIdx < cache.maxPeaks.length) {
                        maxVal = cache.maxPeaks[baseIdx] * (1 - weight) + cache.maxPeaks[nextIdx] * weight;
                        minVal = cache.minPeaks[baseIdx] * (1 - weight) + cache.minPeaks[nextIdx] * weight;
                    }
                } else {
                    const idxS = Math.max(0, Math.floor(cacheIdxStart));
                    const idxE = Math.min(cache.maxPeaks.length, Math.ceil(cacheIdxEnd));
                    for (let k = idxS; k < idxE; k++) {
                        if (cache.maxPeaks[k] > maxVal) maxVal = cache.maxPeaks[k];
                        if (cache.minPeaks[k] < minVal) minVal = cache.minPeaks[k];
                    }
                }

                topPoints[col] = centerY - (maxVal * ampHeight);
                bottomPoints[col] = centerY - (minVal * ampHeight);
            }

            const playheadPercent = (playheadSec - viewStartSec) / viewDuration;
            const playheadX = Math.max(0, Math.min(rectWidth, playheadPercent * rectWidth));

            const drawAmbientGlowPass = (clipXStart, clipXEnd, useActiveColors) => {
                ctx.save();
                ctx.beginPath();
                ctx.rect(clipXStart, 0, clipXEnd - clipXStart, rectHeight);
                ctx.clip();

                ctx.beginPath();
                ctx.moveTo(0, centerY);
                for (let x = 0; x < rectWidth; x++) ctx.lineTo(x, topPoints[x]);
                ctx.lineTo(rectWidth, centerY);
                for (let x = rectWidth - 1; x >= 0; x--) ctx.lineTo(x, bottomPoints[x]);
                ctx.closePath();

                ctx.shadowColor = useActiveColors ? 'rgba(160, 118, 249, 0.7)' : 'rgba(122, 82, 201, 0.2)';
                ctx.shadowBlur = useActiveColors ? 16 : 8;
                ctx.shadowOffsetY = 2;

                ctx.fillStyle = useActiveColors ? 'rgba(122, 82, 201, 0.25)' : 'rgba(62, 50, 86, 0.12)';
                ctx.fill();
                ctx.restore();
            };

            const drawLiquidGlassPass = (clipXStart, clipXEnd, useActiveColors) => {
                ctx.save();
                ctx.beginPath();
                ctx.rect(clipXStart, 0, clipXEnd - clipXStart, rectHeight);
                ctx.clip();

                ctx.beginPath();
                ctx.moveTo(0, centerY);
                for (let x = 0; x < rectWidth; x++) ctx.lineTo(x, topPoints[x]);
                ctx.lineTo(rectWidth, centerY);
                for (let x = rectWidth - 1; x >= 0; x--) ctx.lineTo(x, bottomPoints[x]);
                ctx.closePath();

                const liquidGrad = ctx.createLinearGradient(0, centerY - ampHeight, 0, centerY + ampHeight);
                if (useActiveColors) {
                    liquidGrad.addColorStop(0.0, 'rgba(185, 155, 255, 0.85)');
                    liquidGrad.addColorStop(0.25, 'rgba(160, 118, 249, 0.45)');
                    liquidGrad.addColorStop(0.48, 'rgba(122, 82, 201, 0.22)');
                    liquidGrad.addColorStop(0.52, 'rgba(95, 59, 163, 0.32)');
                    liquidGrad.addColorStop(0.75, 'rgba(122, 82, 201, 0.55)');
                    liquidGrad.addColorStop(1.0, 'rgba(160, 118, 249, 0.9)');
                } else {
                    liquidGrad.addColorStop(0.0, 'rgba(110, 90, 160, 0.35)');
                    liquidGrad.addColorStop(0.25, 'rgba(62, 50, 86, 0.22)');
                    liquidGrad.addColorStop(0.5, 'rgba(28, 24, 40, 0.4)');
                    liquidGrad.addColorStop(0.75, 'rgba(46, 36, 68, 0.22)');
                    liquidGrad.addColorStop(1.0, 'rgba(75, 60, 115, 0.45)');
                }

                ctx.fillStyle = liquidGrad;
                ctx.fill();
                ctx.fillStyle = useActiveColors ? 'rgba(255, 255, 255, 0.04)' : 'rgba(255, 255, 255, 0.01)';
                ctx.fill();
                ctx.restore();
            };

            const drawSpecularContourPass = (clipXStart, clipXEnd, useActiveColors) => {
                ctx.save();
                ctx.beginPath();
                ctx.rect(clipXStart, 0, clipXEnd - clipXStart, rectHeight);
                ctx.clip();

                ctx.beginPath();
                ctx.moveTo(0, topPoints[0]);
                for (let x = 1; x < rectWidth; x++) ctx.lineTo(x, topPoints[x]);
                ctx.strokeStyle = useActiveColors ? '#f1ebff' : 'rgba(177, 142, 255, 0.35)';
                ctx.lineWidth = 1.25;
                ctx.stroke();

                ctx.beginPath();
                ctx.moveTo(0, topPoints[0] + 1.5);
                for (let x = 1; x < rectWidth; x++) ctx.lineTo(x, topPoints[x] + 1.5);
                ctx.strokeStyle = useActiveColors ? 'rgba(255, 255, 255, 0.38)' : 'rgba(255, 255, 255, 0.06)';
                ctx.lineWidth = 0.75;
                ctx.stroke();

                ctx.beginPath();
                ctx.moveTo(0, bottomPoints[0]);
                for (let x = 1; x < rectWidth; x++) ctx.lineTo(x, bottomPoints[x]);
                ctx.strokeStyle = useActiveColors ? 'rgba(160, 118, 249, 0.75)' : 'rgba(122, 82, 201, 0.2)';
                ctx.lineWidth = 1.0;
                ctx.stroke();

                ctx.restore();
            };

            drawAmbientGlowPass(0, rectWidth, false);
            drawLiquidGlassPass(0, rectWidth, false);
            drawSpecularContourPass(0, rectWidth, false);

            if (playheadX > 0) {
                drawAmbientGlowPass(0, playheadX, true);
                drawLiquidGlassPass(0, playheadX, true);
                drawSpecularContourPass(0, playheadX, true);
            }

            const renderOverlayZone = (start, end, fill, stroke) => {
                if (end <= start) return;
                const visS = Math.max(viewStartSec, start);
                const visE = Math.min(viewEndSec, end);
                if (visE <= visS) return;

                const xS = ((visS - viewStartSec) / viewDuration) * rectWidth;
                const xE = ((visE - viewStartSec) / viewDuration) * rectWidth;

                ctx.fillStyle = fill;
                ctx.fillRect(xS, 0, xE - xS, rectHeight);
                ctx.strokeStyle = stroke;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(xS, 0); ctx.lineTo(xS, rectHeight);
                ctx.moveTo(xE, 0); ctx.lineTo(xE, rectHeight);
                ctx.stroke();
            };

            if (loopEndSec > loopStartSec) {
                renderOverlayZone(loopStartSec, loopEndSec, 'rgba(160, 118, 249, 0.08)', 'rgba(160, 118, 249, 0.4)');
            }
            if (dragEndSec > dragStartSec) {
                renderOverlayZone(dragStartSec, dragEndSec, 'rgba(255, 255, 255, 0.04)', 'rgba(255, 255, 255, 0.3)');
            }

            if (playheadSec >= viewStartSec && playheadSec <= viewEndSec) {
                ctx.save();
                ctx.shadowColor = '#b18eff';
                ctx.shadowBlur = 10;
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.5;
                
                ctx.beginPath();
                ctx.moveTo(playheadX, 0);
                ctx.lineTo(playheadX, rectHeight);
                ctx.stroke();
                ctx.restore();

                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(playheadX, 2, 2, 0, Math.PI * 2);
                ctx.arc(playheadX, rectHeight - 2, 2, 0, Math.PI * 2);
                ctx.fill();
            }

            ctx.beginPath();
            ctx.moveTo(0, centerY);
            ctx.lineTo(rectWidth, centerY);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.restore();
        }
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
        }, APP_CONFIG.DEBOUNCE_TIMES[type.toUpperCase()]);
    }

    function updatePlayButton(button, isPlaying) {
        if (!button) return;
        const icon = button.querySelector('i');
        if (isPlaying) {
            button.classList.add('playing');
            if (icon) icon.className = 'fas fa-pause';
        } else {
            button.classList.remove('playing');
            if (icon) icon.className = 'fas fa-play';
        }
    }

    async function initExtension() {
        try {
            initTheme();
            await I18N.init();
            STATE.dbInstance = await openDatabase();
            STATE.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            setupVisualizer(null);
            
            // Load custom settings definitions from storage if available
            await loadExtensionSettings();
            
            await loadRecordings();
            updateStorageStatus();
            checkAndShowWarningModal();
            setupEventListeners();
            ELEMENTS.statusMessage.textContent = I18N.get('status_ready');
        } catch (error) {
            handleError(error, 'Initialization');
            ELEMENTS.statusMessage.textContent = I18N.get('status_init_failed');
        }
    }

    function openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(APP_CONFIG.DB.NAME, APP_CONFIG.DB.VERSION);
            request.onerror = (event) => reject(new Error(`Database error: ${event.target.error.message}`));
            request.onsuccess = (event) => resolve(event.target.result);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (db.objectStoreNames.contains('recordings')) {
                    db.deleteObjectStore('recordings');
                }
                const store = db.createObjectStore('recordings', { keyPath: 'id' });
                store.createIndex('createdAt', 'createdAt', { unique: false });
            };
        });
    }

    async function getRecordingsFromDB() {
        return new Promise((resolve, reject) => {
            const transaction = STATE.dbInstance.transaction(['recordings'], 'readonly');
            const store = transaction.objectStore('recordings');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = (event) => reject(new Error(`Failed to retrieve recordings: ${event.target.error.message}`));
        });
    }

    async function saveRecording(recording) {
        return new Promise((resolve, reject) => {
            const transaction = STATE.dbInstance.transaction(['recordings'], 'readwrite');
            const store = transaction.objectStore('recordings');
            const request = store.put(recording);
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject(new Error(`Failed to save recording: ${event.target.error.message}`));
        });
    }

    async function deleteRecordingFromDB(id) {
        return new Promise((resolve, reject) => {
            const transaction = STATE.dbInstance.transaction(['recordings'], 'readwrite');
            const store = transaction.objectStore('recordings');
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject(new Error(`Failed to delete recording: ${event.target.error.message}`));
        });
    }

    async function clearAllRecordingsFromDB() {
        return new Promise((resolve, reject) => {
            const transaction = STATE.dbInstance.transaction(['recordings'], 'readwrite');
            const store = transaction.objectStore('recordings');
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject(new Error(`Failed to empty database: ${event.target.error.message}`));
        });
    }

    async function captureTabAudio() {
        return new Promise((resolve, reject) => {
            if (typeof chrome !== 'undefined' && chrome.tabCapture) {
                chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
                    if (chrome.runtime.lastError || !stream) {
                        reject(new Error(chrome.runtime.lastError?.message || 'Failed to capture tab audio'));
                        return;
                    }
                    STATE.audioElement = new Audio();
                    STATE.audioElement.srcObject = stream;
                    STATE.audioElement.play().catch(e => console.error('Audio stream pass-through error:', e));
                    resolve(stream);
                });
            } else {
                // Fallback for standalone/development sandboxes
                navigator.mediaDevices.getUserMedia({ audio: true })
                    .then(stream => resolve(stream))
                    .catch(err => reject(new Error(`User media capture blocked or unconfigured: ${err.message}`)));
            }
        });
    }

    async function processAudioBuffer(audioData) {
        try {
            const arrayBuffer = await audioData.arrayBuffer();
            const audioBuffer = await STATE.audioContext.decodeAudioData(arrayBuffer);
            const sampleRate = audioBuffer.sampleRate;
            const numChannels = audioBuffer.numberOfChannels;
            const silenceSamples = sampleRate * 1;
            const newLength = audioBuffer.length + (silenceSamples * 2);
            const paddedBuffer = STATE.audioContext.createBuffer(numChannels, newLength, sampleRate);
            const originalSerialized = [];

            for (let channel = 0; channel < numChannels; channel++) {
                const srcData = audioBuffer.getChannelData(channel);
                const destData = paddedBuffer.getChannelData(channel);
                for (let i = 0; i < silenceSamples; i++) destData[i] = 0;
                for (let i = 0; i < srcData.length; i++) destData[i + silenceSamples] = srcData[i];
                for (let i = silenceSamples + srcData.length; i < newLength; i++) destData[i] = 0;
                originalSerialized.push(Array.from(destData));
            }
            return { original: originalSerialized, duration: Math.round(paddedBuffer.duration * 1000) };
        } catch (error) {
            throw new Error(`Audio compilation sequence failed: ${error.message}`);
        }
    }

    function buildAudioBufferFromSerialized(serialized, reverseSamples = false) {
        if (!STATE.audioContext) throw new Error('AudioContext missing.');
        const sampleRate = STATE.audioContext.sampleRate;
        const numChannels = serialized.length;
        const length = serialized[0].length;
        const audioBuffer = STATE.audioContext.createBuffer(numChannels, length, sampleRate);

        for (let ch = 0; ch < numChannels; ch++) {
            const channelData = audioBuffer.getChannelData(ch);
            if (reverseSamples) {
                for (let i = 0; i < length; i++) {
                    channelData[i] = serialized[ch][length - 1 - i];
                }
            } else {
                channelData.set(serialized[ch]);
            }
        }
        return audioBuffer;
    }

    function getLivePlaybackTime() {
        const cp = STATE.currentPlayback;
        if (cp.isPaused || !cp.audioBuffer) return cp.pauseTime;
        const elapsed = (STATE.audioContext.currentTime - cp.playbackStartTimestamp) * cp.playbackRate;
        const duration = cp.audioBuffer.duration;

        if (!cp.isReversed) {
            let currentPos = cp.startOffset + elapsed;
            if (cp.loopEnabled && cp.loopEnd > cp.loopStart) {
                const loopLen = cp.loopEnd - cp.loopStart;
                if (loopLen > 0 && currentPos >= cp.loopStart) {
                    currentPos = cp.loopStart + ((currentPos - cp.loopStart) % loopLen);
                }
            }
            return Math.max(0, Math.min(currentPos, duration));
        } else {
            const offsetRev = duration - cp.startOffset;
            let currentPosRev = offsetRev + elapsed;
            if (cp.loopEnabled) {
                const loopStartRev = duration - cp.loopEnd;
                const loopEndRev = duration - cp.loopStart;
                const loopLen = loopEndRev - loopStartRev;
                if (loopLen > 0 && currentPosRev >= loopStartRev) {
                    currentPosRev = loopStartRev + ((currentPosRev - loopStartRev) % loopLen);
                }
            }
            return Math.max(0, Math.min(duration - currentPosRev, duration));
        }
    }

    function stopPlayback() {
        const cp = STATE.currentPlayback;
        if (cp.sourceNode) {
            try { cp.sourceNode.stop(); } catch (e) {}
            cp.sourceNode.disconnect();
            cp.sourceNode = null;
        }
        if (cp.playbackAnimationFrameId) {
            cancelAnimationFrame(cp.playbackAnimationFrameId);
            cp.playbackAnimationFrameId = null;
        }
        cp.isPaused = true;
        updatePlayButton(cp.cardElement?.querySelector('.play-btn'), false);
    }

    async function startPlayback(recordingId, startFromSec = 0) {
        stopPlayback();
        const recording = STATE.allRecordings.find(r => r.id === recordingId);
        if (!recording) return;

        const cp = STATE.currentPlayback;
        cp.id = recordingId;
        cp.cardElement = ELEMENTS.recordingsGrid.querySelector(`[data-id="${recordingId}"]`);
        
        // Intelligent Action: Collapse recording interface when listening to saved elements
        collapseRecorderPanel(true);

        if (!cp.audioBuffer || cp.id !== recordingId) {
            ELEMENTS.statusMessage.textContent = I18N.get('status_compiling');
            cp.audioBuffer = buildAudioBufferFromSerialized(recording.audioData.original, false);
        }

        const duration = cp.audioBuffer.duration;
        if (startFromSec >= duration || startFromSec < 0) startFromSec = 0;

        cp.startOffset = startFromSec;
        cp.playbackStartTimestamp = STATE.audioContext.currentTime;
        cp.isPaused = false;

        cp.sourceNode = STATE.audioContext.createBufferSource();
        cp.sourceNode.buffer = cp.audioBuffer;
        cp.sourceNode.playbackRate.value = cp.playbackRate;

        // Apply programmatic sample-inversion transformations when inverted flag is enabled
        if (cp.isReversed) {
            const reversedBuffer = buildAudioBufferFromSerialized(recording.audioData.original, true);
            cp.sourceNode.buffer = reversedBuffer;
            const revOffset = duration - startFromSec;
            cp.sourceNode.start(0, Math.max(0, revOffset));
            ELEMENTS.statusMessage.textContent = I18N.get('status_playing_reversed');
        } else {
            cp.sourceNode.start(0, startFromSec);
            ELEMENTS.statusMessage.textContent = I18N.get('status_playing');
        }

        cp.sourceNode.connect(STATE.audioContext.destination);
        updatePlayButton(cp.cardElement?.querySelector('.play-btn'), true);

        cp.sourceNode.onended = () => {
            if (!cp.isPaused && !cp.loopEnabled) {
                stopPlayback();
                cp.pauseTime = 0;
                updateCardWaveformDisplay(recordingId);
                ELEMENTS.statusMessage.textContent = I18N.get('status_ready');
            }
        };

        tickPlaybackProgress(recordingId);
    }

    function tickPlaybackProgress(recordingId) {
        const cp = STATE.currentPlayback;
        if (cp.id !== recordingId || cp.isPaused) return;

        const liveTime = getLivePlaybackTime();
        cp.pauseTime = liveTime;
        updateCardWaveformDisplay(recordingId, liveTime);

        cp.playbackAnimationFrameId = requestAnimationFrame(() => tickPlaybackProgress(recordingId));
    }

    function updateCardWaveformDisplay(recordingId, customPlayhead = -1) {
        const card = ELEMENTS.recordingsGrid.querySelector(`[data-id="${recordingId}"]`);
        if (!card) return;

        const canvas = card.querySelector('canvas');
        const cache = STATE.cachedPeaks[recordingId];
        if (!canvas || !cache) return;

        const playhead = customPlayhead >= 0 ? customPlayhead : (STATE.currentPlayback.id === recordingId ? STATE.currentPlayback.pauseTime : 0);
        const viewState = STATE.viewStates[recordingId] || { start: 0, end: cache.duration };

        ProWaveformEngine.render(
            recordingId,
            canvas,
            viewState.start,
            viewState.end,
            playhead,
            -1, -1,
            STATE.currentPlayback.id === recordingId && STATE.currentPlayback.loopEnabled ? STATE.currentPlayback.loopStart : 0,
            STATE.currentPlayback.id === recordingId && STATE.currentPlayback.loopEnabled ? STATE.currentPlayback.loopEnd : 0
        );

        const progressPercent = (playhead / cache.duration) * 100;
        const bar = card.querySelector('.playback-bar');
        if (bar) bar.style.width = `${Math.max(0, Math.min(100, progressPercent))}%`;
    }

    function setupVisualizer(stream) {
        if (STATE.visualizerAnimationFrameId) {
            cancelAnimationFrame(STATE.visualizerAnimationFrameId);
            STATE.visualizerAnimationFrameId = null;
        }

        const canvas = ELEMENTS.visualizer;
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        
        const resizeCanvas = () => {
            const w = ELEMENTS.visualizerContainer.offsetWidth;
            const h = ELEMENTS.visualizerContainer.offsetHeight;
            if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
                canvas.width = w * dpr;
                canvas.height = h * dpr;
                ctx.scale(dpr, dpr);
            }
        };
        resizeCanvas();

        const emptyState = ELEMENTS.visualizerContainer.querySelector('.empty-state');
        if (!stream) {
            ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
            if (emptyState) emptyState.style.display = 'flex';
            return;
        }

        if (emptyState) emptyState.style.display = 'none';
        
        if (!STATE.analyserNode) {
            STATE.analyserNode = STATE.audioContext.createAnalyser();
            STATE.analyserNode.fftSize = 256;
        }
        
        if (STATE.mediaStreamSource) STATE.mediaStreamSource.disconnect();
        STATE.mediaStreamSource = STATE.audioContext.createMediaStreamSource(stream);
        STATE.mediaStreamSource.connect(STATE.analyserNode);

        const bufferLength = STATE.analyserNode.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        const w = canvas.width / dpr;
        const h = canvas.height / dpr;

        function renderFrame() {
            if (!STATE.isRecording) return;
            STATE.visualizerAnimationFrameId = requestAnimationFrame(renderFrame);

            STATE.analyserNode.getByteFrequencyData(dataArray);
            ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg-tertiary').trim() || '#202024';
            ctx.fillRect(0, 0, w, h);

            const barWidth = (w / bufferLength) * 1.4;
            let barHeight;
            let x = 0;

            const accentPrimary = getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim() || '#a076f9';
            ctx.fillStyle = accentPrimary;

            for (let i = 0; i < bufferLength; i++) {
                barHeight = (dataArray[i] / 255) * h * 0.85;
                ctx.beginPath();
                ctx.roundRect(x, h - barHeight - 2, barWidth - 1, barHeight, 4);
                ctx.fill();
                x += barWidth;
            }
        }
        renderFrame();
    }

    async function toggleRecording() {
        if (STATE.isRecording) {
            // Stop logic sequencing
            STATE.isRecording = false;
            ELEMENTS.recordBtn.classList.remove('recording');
            ELEMENTS.recordBtn.querySelector('span').textContent = I18N.get('btn_start_recording');
            ELEMENTS.recIndicator.classList.remove('active');

            if (STATE.mediaRecorder && STATE.mediaRecorder.state !== 'inactive') {
                STATE.mediaRecorder.stop();
            }
            if (STATE.mediaStream) {
                STATE.mediaStream.getTracks().forEach(track => track.stop());
                STATE.mediaStream = null;
            }
            setupVisualizer(null);
        } else {
            // Start verification pipeline
            if (STATE.allRecordings.length >= APP_CONFIG.MAX_RECORDINGS) {
                showModalNotification(I18N.get('msg_storage_limit_reached'), I18N.get('msg_purge_older'));
                return;
            }

            try {
                if (STATE.audioContext.state === 'suspended') {
                    await STATE.audioContext.resume();
                }

                STATE.mediaStream = await captureTabAudio();
                setupVisualizer(STATE.mediaStream);

                STATE.recordingChunks = [];
                STATE.mediaRecorder = new MediaRecorder(STATE.mediaStream, { mimeType: 'audio/webm' });
                
                STATE.mediaRecorder.ondataavailable = (e) => {
                    if (e.data && e.data.size > 0) STATE.recordingChunks.push(e.data);
                };

                STATE.mediaRecorder.onstop = async () => {
                    ELEMENTS.statusMessage.textContent = I18N.get('status_parsing_stream');
                    const blob = new Blob(STATE.recordingChunks, { type: 'audio/webm' });
                    
                    try {
                        const processed = await processAudioBuffer(blob);
                        const recordingId = `${I18N.get('recording_card_prefix') || 'Rec_'}${Date.now()}`;
                        
                        const newRecording = {
                            id: recordingId,
                            title: `Track Alpha ${STATE.allRecordings.length + 1}`,
                            duration: processed.duration,
                            createdAt: Date.now(),
                            audioData: processed
                        };

                        await saveRecording(newRecording);
                        await loadRecordings();
                        updateStorageStatus();
                        ELEMENTS.statusMessage.textContent = I18N.get('status_recorded_cleanly');
                        
                        // Smart Action Auto-collapse panel to optimize visual space for output review
                        setTimeout(() => collapseRecorderPanel(true), 600);
                    } catch (err) {
                        handleError(err, 'Audio compilation sequence');
                    }
                };

                STATE.mediaRecorder.start(250);
                STATE.isRecording = true;
                ELEMENTS.recordBtn.classList.add('recording');
                ELEMENTS.recordBtn.querySelector('span').textContent = I18N.get('btn_stop_recording');
                ELEMENTS.recIndicator.classList.add('active');
                ELEMENTS.statusMessage.textContent = I18N.get('recording_status');
            } catch (err) {
                handleError(err, 'Capture Pipeline initiation');
                STATE.isRecording = false;
                ELEMENTS.recordBtn.classList.remove('recording');
                ELEMENTS.recIndicator.classList.remove('active');
            }
        }
    }

    async function loadRecordings() {
        try {
            let recordings = await getRecordingsFromDB();
            
            recordings.sort((a, b) => {
                return STATE.sortOrder === 'newest' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt;
            });

            STATE.allRecordings = recordings;
            renderRecordingsDOM();
            
            // Auto minimize screen real estate profile if loaded repository contains multiple assets
            if (recordings.length > 0 && !STATE.isRecording) {
                collapseRecorderPanel(true);
            } else if (recordings.length === 0) {
                collapseRecorderPanel(false);
            }
        } catch (err) {
            handleError(err, 'Repository loading mapping execution');
        }
    }

    function renderRecordingsDOM() {
        const grid = ELEMENTS.recordingsGrid;
        const template = ELEMENTS.recordingTemplate;
        
        // Clear grid contents safely
        const emptyState = grid.querySelector('.empty-recordings-state');
        grid.innerHTML = '';
        if (emptyState) grid.appendChild(emptyState);

        if (STATE.allRecordings.length === 0) {
            if (emptyState) emptyState.style.display = 'block';
            return;
        }
        if (emptyState) emptyState.style.display = 'none';

        STATE.allRecordings.forEach(rec => {
            const clone = template.content.cloneNode(true);
            const card = clone.querySelector('.recording-card');
            card.setAttribute('data-id', rec.id);
            
            card.querySelector('.card-title').textContent = rec.title;
            card.querySelector('.card-time').textContent = formatDuration(rec.duration);

            // Bind contextual sub-buttons event operations
            const playBtn = card.querySelector('.play-btn');
            playBtn.addEventListener('click', () => {
                if (STATE.currentPlayback.id === rec.id && !STATE.currentPlayback.isPaused) {
                    stopPlayback();
                    ELEMENTS.statusMessage.textContent = I18N.get('status_paused');
                } else {
                    const startPos = STATE.currentPlayback.id === rec.id ? STATE.currentPlayback.pauseTime : 0;
                    startPlayback(rec.id, startPos);
                }
            });

            const revBtn = card.querySelector('.reverse-btn');
            revBtn.addEventListener('click', () => {
                const cp = STATE.currentPlayback;
                if (cp.id === rec.id) {
                    cp.isReversed = !cp.isReversed;
                    revBtn.classList.toggle('active-accent', cp.isReversed);
                    if (!cp.isPaused) {
                        startPlayback(rec.id, cp.pauseTime);
                    } else {
                        updateCardWaveformDisplay(rec.id);
                    }
                } else {
                    cp.isReversed = !cp.isReversed;
                    revBtn.classList.toggle('active-accent', cp.isReversed);
                }
            });

            // Initialize playback cache
            if (!STATE.cachedPeaks[rec.id]) {
                const tempBuffer = buildAudioBufferFromSerialized(rec.audioData.original, false);
                ProWaveformEngine.generateCache(rec.id, tempBuffer, 64);
            }

            const speedDisplay = card.querySelector('.speed-display');
            card.querySelector('.speedUp').addEventListener('click', () => {
                adjustSpeed(rec.id, 1, speedDisplay);
            });
            card.querySelector('.speedDown').addEventListener('click', () => {
                adjustSpeed(rec.id, -1, speedDisplay);
            });

            card.querySelector('.delete-btn').addEventListener('click', async () => {
                if (STATE.currentPlayback.id === rec.id) stopPlayback();
                await deleteRecordingFromDB(rec.id);
                await loadRecordings();
                updateStorageStatus();
                ELEMENTS.statusMessage.textContent = I18N.get('status_track_removed');
            });

            grid.appendChild(clone);
            updateCardWaveformDisplay(rec.id);
        });
    }

    function adjustSpeed(recordingId, direction, displayElement) {
        const cp = STATE.currentPlayback;
        let currentIdx = APP_CONFIG.SPEED_LEVELS.indexOf(cp.playbackRate);
        if (currentIdx === -1) currentIdx = 4; // default index for 1x

        let nextIdx = currentIdx + direction;
        if (nextIdx >= 0 && nextIdx < APP_CONFIG.SPEED_LEVELS.length) {
            const newRate = APP_CONFIG.SPEED_LEVELS[nextIdx];
            cp.playbackRate = newRate;
            if (displayElement) displayElement.textContent = `${newRate.toFixed(2)}x`;
            
            if (cp.id === recordingId && !cp.isPaused) {
                startPlayback(recordingId, cp.pauseTime);
            }
        }
    }

    function collapseRecorderPanel(shouldCollapse) {
        if (shouldCollapse) {
            ELEMENTS.recorderPanel.classList.add('collapsed');
            const toggleIcon = ELEMENTS.togglePanelBtn.querySelector('i');
            if (toggleIcon) toggleIcon.className = 'fas fa-chevron-down';
        } else {
            ELEMENTS.recorderPanel.classList.remove('collapsed');
            const toggleIcon = ELEMENTS.togglePanelBtn.querySelector('i');
            if (toggleIcon) toggleIcon.className = 'fas fa-chevron-up';
        }
    }

    function updateStorageStatus() {
        let totalAllocatedBytes = 0;
        STATE.allRecordings.forEach(rec => {
            if (rec.audioData && rec.audioData.original) {
                rec.audioData.original.forEach(chan => {
                    totalAllocatedBytes += chan.length * 4; // Float32 sizing matrix multiplier
                });
            }
        });

        const megabytesAllocated = totalAllocatedBytes / (1024 * 1024);
        const ceilingLimit = APP_CONFIG.TOTAL_STORAGE_LIMIT / (1024 * 1024);
        ELEMENTS.storageStatus.textContent = `${megabytesAllocated.toFixed(1)} MB of ${ceilingLimit} MB`;
        
        const infoBar = document.getElementById('storageInfo');
        if (megabytesAllocated > ceilingLimit * 0.85) {
            infoBar.style.color = 'var(--danger)';
        } else if (megabytesAllocated > ceilingLimit * 0.6) {
            infoBar.style.color = 'var(--warning)';
        } else {
            infoBar.style.color = '';
        }
    }

    /**
     * Settings Engine Persistence Actions
     */
    async function saveExtensionSettings() {
        const payload = {
            lang: ELEMENTS.langSelect.value,
            temp1: document.getElementById('tempSetting1').checked,
            temp2: document.getElementById('tempSetting2').checked
        };
        
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.set({ appSettings: payload });
        } else {
            localStorage.setItem('reverse_app_settings', JSON.stringify(payload));
        }
        
        // Trigger multi-language swap routines dynamically
        if (payload.lang !== STATE.currentLanguage) {
            STATE.currentLanguage = payload.lang;
            // Dynamic localization translation trigger context
            ELEMENTS.statusMessage.textContent = I18N.get('status_ready');
        }
    }

    async function loadExtensionSettings() {
        let settings = null;
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            const data = await new Promise(r => chrome.storage.local.get(['appSettings'], r));
            settings = data?.appSettings;
        } else {
            const localRaw = localStorage.getItem('reverse_app_settings');
            if (localRaw) settings = JSON.parse(localRaw);
        }

        if (settings) {
            if (settings.lang) ELEMENTS.langSelect.value = settings.lang;
            STATE.currentLanguage = settings.lang || 'en';
            document.getElementById('tempSetting1').checked = !!settings.temp1;
            document.getElementById('tempSetting2').checked = !!settings.temp2;
        }
    }

    function showModalNotification(title, message) {
        ELEMENTS.infoModalTitle.textContent = title;
        ELEMENTS.infoModalMessage.textContent = message;
        ELEMENTS.infoModal.classList.add('active-flex');
    }

    function hideModalNotification() {
        ELEMENTS.infoModal.classList.remove('active-flex');
    }

    function setupEventListeners() {
        ELEMENTS.recordBtn.addEventListener('click', () => {
            debounce(null, 'record', async () => {
                await toggleRecording();
            });
        });

        ELEMENTS.togglePanelBtn.addEventListener('click', () => {
            const isCurrentlyCollapsed = ELEMENTS.recorderPanel.classList.contains('collapsed');
            collapseRecorderPanel(!isCurrentlyCollapsed);
        });

        // Beautiful glass settings trigger configurations 
        ELEMENTS.settingsModalBtn.addEventListener('click', () => {
            ELEMENTS.settingsModal.classList.add('active-flex');
        });

        ELEMENTS.closeSettingsBtn.addEventListener('click', () => {
            ELEMENTS.settingsModal.classList.remove('active-flex');
        });

        // Settings option change hooks
        ELEMENTS.langSelect.addEventListener('change', saveExtensionSettings);
        document.getElementById('tempSetting1').addEventListener('change', saveExtensionSettings);
        document.getElementById('tempSetting2').addEventListener('change', saveExtensionSettings);

        // Emergency Clear Action
        ELEMENTS.clearAllRecordingsBtn.addEventListener('click', async () => {
            if (confirm("Are you sure you want to clear all recordings from localized index storage stores?")) {
                stopPlayback();
                await clearAllRecordingsFromDB();
                await loadRecordings();
                updateStorageStatus();
                ELEMENTS.settingsModal.classList.remove('active-flex');
                ELEMENTS.statusMessage.textContent = I18N.get('status_ready');
            }
        });

        // Info Notification Modal handling hooks
        ELEMENTS.infoModalOkBtn.addEventListener('click', hideModalNotification);
        const innerClose = ELEMENTS.infoModal.querySelector('.info-close');
        if (innerClose) innerClose.addEventListener('click', hideModalNotification);

        // Backdrop dismissal alignment checks
        window.addEventListener('click', (e) => {
            if (e.target === ELEMENTS.settingsModal) ELEMENTS.settingsModal.classList.remove('active-flex');
            if (e.target === ELEMENTS.infoModal) hideModalNotification();
        });

        ELEMENTS.themeToggle.addEventListener('click', () => {
            const doc = document.documentElement;
            if (doc.classList.contains('theme-light')) {
                doc.classList.remove('theme-light');
                doc.classList.add('theme-dark');
                ELEMENTS.themeToggle.querySelector('i').className = 'fas fa-sun';
            } else {
                doc.classList.remove('theme-dark');
                doc.classList.add('theme-light');
                ELEMENTS.themeToggle.querySelector('i').className = 'fas fa-moon';
            }
        });

        ELEMENTS.sortSelect.addEventListener('change', (e) => {
            STATE.sortOrder = e.target.value;
            loadRecordings();
        });
    }

    function initTheme() {
        // Ensure default dark variant mapping exists on load logic setup
        if (!document.documentElement.classList.contains('theme-light') && !document.documentElement.classList.contains('theme-dark')) {
            document.documentElement.classList.add('theme-dark');
        }
    }

    function checkAndShowWarningModal() {
        const ceilingLimit = APP_CONFIG.MAX_RECORDINGS;
        if (STATE.allRecordings.length >= ceilingLimit * 0.9) {
            showModalNotification(I18N.get('warning_title') || "Storage Warning", I18N.get('msg_purge_older') || "Please purge older tracks to keep optimal memory parameters.");
        }
    }

    function formatDuration(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    }

    function handleError(error, context) {
        console.error(`Error detected during channel loop [${context}]:`, error);
        if (ELEMENTS.statusMessage) {
            ELEMENTS.statusMessage.textContent = `Error: ${error.message || error}`;
        }
    }

    // Fire application structural load sequences
    initExtension();
});