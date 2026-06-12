window.addEventListener('DOMContentLoaded', () => {
    const APP_NAME = 'RE-VERSE';

    const APP_CONFIG = {
        MAX_RECORDINGS: 20,
        MAX_RECORDING_SIZE: 48 * 1024 * 1024,
        TOTAL_STORAGE_LIMIT: 74 * 1024 * 1024,
        RECORDING_WARNING_THRESHOLD_YELLOW: 10,
        RECORDING_WARNING_THRESHOLD_RED: 18,
        STORAGE_WARNING_THRESHOLD: 48 * 1024 * 1024,
        SPEED_LEVELS: [.38, .48, .59, .74, .88, 1, 1.4, 2.08, 3.03],
        DB: { NAME: 'AudioReverserDB', VERSION: 4 },
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
        closeSettingsBtn: document.querySelector('#settingsModal .close-btn')
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
        audioElement: null
    };

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
        const text = button.querySelector('span');
        if (isPlaying) {
            button.classList.add('playing');
            if (icon) icon.className = 'fas fa-pause';
            if (text) text.textContent = I18N.get('btn_pause');
        } else {
            button.classList.remove('playing');
            if (icon) icon.className = 'fas fa-play';
            if (text) text.textContent = I18N.get('btn_play');
        }
    }

    async function initExtension() {
        try {
            initTheme();
            await I18N.init();
            STATE.dbInstance = await openDatabase();
            STATE.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            setupVisualizer(null);
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

    async function captureTabAudio() {
        return new Promise((resolve, reject) => {
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

            return {
                original: originalSerialized,
                duration: Math.round(paddedBuffer.duration * 1000)
            };
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

        cp.pauseTime = getLivePlaybackTime();
        cp.isPaused = true;
        
        stopPlayback();
        updatePlaybackUI();
        ELEMENTS.statusMessage.textContent = I18N.get('status_paused');
    }

    async function startPlayback(recordingId, reverse = false, startTime = 0, loopStart = 0, loopEnd = 0, speed = 1) {
        stopPlayback();
        try {
            STATE.activeOperations.playback = true;
            const recording = STATE.allRecordings.find(r => r.id === recordingId);
            if (!recording) throw new Error('Target profile missing.');

            const card = document.querySelector(`.recording-card[data-id="${recordingId}"]`);
            const buffer = buildAudioBufferFromSerialized(recording.original, reverse);
            const duration = buffer.duration;
            
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
            cp.isReversed = reverse;
            cp.startOffset = safeStart;
            cp.pauseTime = safeStart;
            cp.loopStart = safeLoopStart;
            cp.loopEnd = safeLoopEnd;
            cp.playbackRate = speed;
            cp.loopEnabled = safeLoopEnd > safeLoopStart;

            let physicalOffset = safeStart;
            let srcLoopStart = safeLoopStart;
            let srcLoopEnd = safeLoopEnd;

            if (reverse) {
                physicalOffset = Math.max(0, duration - safeStart);
                srcLoopStart = Math.max(0, duration - safeLoopEnd);
                srcLoopEnd = Math.max(0, duration - safeLoopStart);
            }

            if (cp.loopEnabled && srcLoopEnd > srcLoopStart) {
                sourceNode.loop = true;
                sourceNode.loopStart = srcLoopStart;
                sourceNode.loopEnd = srcLoopEnd;
            }

            cp.playbackStartTimestamp = STATE.audioContext.currentTime;
            sourceNode.start(0, physicalOffset);

            sourceNode.onended = () => {
                if (STATE.currentPlayback.id === recordingId && !sourceNode.loop && !STATE.currentPlayback.isPaused) {
                    resetPlaybackState();
                }
            };

            updatePlaybackUI();
            ELEMENTS.statusMessage.textContent = reverse ? I18N.get('status_playing_reversed') : I18N.get('status_playing');
            
            const canvas = card.querySelector('canvas');
            if (canvas) spawnCardViewportController(recordingId, canvas);

        } catch (error) {
            handleError(error, 'Playback Engine');
            resetPlaybackState();
        } finally {
            STATE.activeOperations.playback = false;
        }
    }

    function resetPlaybackState() {
        const previousActiveId = STATE.currentPlayback.id;
        stopPlayback();
        STATE.currentPlayback = {
            id: null, sourceNode: null, audioBuffer: null, isPaused: true, isReversed: false,
            playbackStartTimestamp: 0, pauseTime: 0, loopStart: 0, loopEnd: 0,
            cardElement: null, playbackAnimationFrameId: null, startOffset: 0, playbackRate: 1, loopEnabled: false
        };
        updateAllPlaybackCardUIs();
        ELEMENTS.statusMessage.textContent = I18N.get('status_ready');

        if (previousActiveId) {
            const card = document.querySelector(`.recording-card[data-id="${previousActiveId}"]`);
            const canvas = card?.querySelector('canvas');
            if (canvas) requestAnimationFrame(() => spawnCardViewportController(previousActiveId, canvas));
        }
    }

    function togglePlayPause(recordingId) {
        const cp = STATE.currentPlayback;
        const isCurrentTrack = cp.id === recordingId;
        const recording = STATE.allRecordings.find(r => r.id === recordingId);
        if (!recording) return;

        if (isCurrentTrack && !cp.isPaused) {
            pausePlayback();
        } else if (isCurrentTrack && cp.isPaused) {
            startPlayback(recordingId, cp.isReversed, cp.pauseTime, cp.loopStart, cp.loopEnd, cp.playbackRate);
        } else {
            resetPlaybackState();
            startPlayback(recordingId, recording.isReversed, 0, 0, 0, recording.speed || 1);
        }
    }

    async function toggleReverse(recordingId) {
        const recording = STATE.allRecordings.find(r => r.id === recordingId);
        if (!recording) return;

        recording.isReversed = !recording.isReversed;
        await saveRecording(recording);

        const card = document.querySelector(`.recording-card[data-id="${recordingId}"]`);
        if (card) {
            const reverseBtn = card.querySelector('.reverse-btn');
            if (reverseBtn) reverseBtn.classList.toggle('active', recording.isReversed);
            card.classList.toggle('reversed', recording.isReversed);
        }

        if (STATE.currentPlayback.id === recordingId) {
            const cp = STATE.currentPlayback;
            const currentForwardPos = getLivePlaybackTime();
            const wasPaused = cp.isPaused;

            stopPlayback();
            await startPlayback(recordingId, recording.isReversed, currentForwardPos, cp.loopStart, cp.loopEnd, cp.playbackRate);
            if (wasPaused) pausePlayback();
        }
    }

    function updatePlaybackUI() {
        const cp = STATE.currentPlayback;
        if (!cp.id || !cp.cardElement || !cp.audioBuffer) {
            updateAllPlaybackCardUIs();
            return;
        }

        const playButton = cp.cardElement.querySelector('.play-btn');
        document.querySelectorAll('.recording-card').forEach(c => {
            if (c !== cp.cardElement) c.classList.remove('playing');
        });
        cp.cardElement.classList.add('playing');
        updatePlayButton(playButton, !cp.isPaused);
    }

    function updateAllPlaybackCardUIs() {
        document.querySelectorAll('.recording-card').forEach(card => {
            card.classList.remove('playing');
            const playBtn = card.querySelector('.play-btn');
            if (playBtn) updatePlayButton(playBtn, false);
            
            const rec = STATE.allRecordings.find(r => r.id === card.dataset.id);
            const speedDisplay = card.querySelector('.speed-display');
            if (speedDisplay && rec) speedDisplay.textContent = `${(rec.speed || 1).toFixed(2)}x`;
        });
    }

    async function updatePlaybackSpeed(recordingId, newSpeedIndex) {
        const newSpeed = APP_CONFIG.SPEED_LEVELS[newSpeedIndex];
        const recording = STATE.allRecordings.find(r => r.id === recordingId);
        if (!recording) return;

        recording.speed = newSpeed;
        await saveRecording(recording);

        const card = document.querySelector(`.recording-card[data-id="${recordingId}"]`);
        if (card) {
            const speedDisplay = card.querySelector('.speed-display');
            if (speedDisplay) speedDisplay.textContent = `${newSpeed.toFixed(2)}x`;
        }

        if (STATE.currentPlayback.id === recordingId) {
            const cp = STATE.currentPlayback;
            const currentPos = getLivePlaybackTime();
            const wasPaused = cp.isPaused;

            stopPlayback();
            await startPlayback(recordingId, cp.isReversed, currentPos, cp.loopStart, cp.loopEnd, newSpeed);
            if (wasPaused) pausePlayback();
        }
    }

    function spawnCardViewportController(recordingId, canvas) {
        const state = STATE.viewStates[recordingId];
        if (!state || state.animationActive) return;

        state.animationActive = true;

        const loop = () => {
            const vs = STATE.viewStates[recordingId];
            if (!vs) return;

            const diffStart = vs.targetStart - vs.currentStart;
            const diffEnd = vs.targetEnd - vs.currentEnd;

            if (Math.abs(diffStart) > 0.0001 || Math.abs(diffEnd) > 0.0001) {
                vs.currentStart += diffStart * APP_CONFIG.ZOOM.LERP_FACTOR;
                vs.currentEnd += diffEnd * APP_CONFIG.ZOOM.LERP_FACTOR;
            } else {
                vs.currentStart = vs.targetStart;
                vs.currentEnd = vs.targetEnd;
            }

            const playhead = (STATE.currentPlayback.id === recordingId) ? getLivePlaybackTime() : -1;
            const loopS = (STATE.currentPlayback.id === recordingId) ? STATE.currentPlayback.loopStart : 0;
            const loopE = (STATE.currentPlayback.id === recordingId) ? STATE.currentPlayback.loopEnd : 0;

            ProWaveformEngine.render(
                recordingId, canvas, 
                vs.currentStart, vs.currentEnd, 
                playhead, 
                vs.dragStartSec, vs.dragEndSec,
                loopS, loopE
            );

            const isPlayingThis = (STATE.currentPlayback.id === recordingId && !STATE.currentPlayback.isPaused);
            const isInterpolating = (vs.currentStart !== vs.targetStart || vs.currentEnd !== vs.targetEnd);

            if (isInterpolating || isPlayingThis || vs.isDragging) {
                requestAnimationFrame(loop);
            } else {
                state.animationActive = false;
            }
        };

        requestAnimationFrame(loop);
    }

    function createRecordingCard(recording) {
        const card = ELEMENTS.recordingTemplate.content.cloneNode(true).firstElementChild;
        I18N.translateDOM(card);
        
        const date = new Date(recording.createdAt);
        card.dataset.id = recording.id;
        card.querySelector('.card-title').textContent = `${I18N.get('recording_card_prefix')}${date.getHours()}${date.getMinutes()}_${date.getSeconds()}`;
        card.querySelector('.card-time').textContent = formatDuration(recording.duration);
        
        const canvas = card.querySelector('.waveform-container canvas');
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

        let structuralBuffer = buildAudioBufferFromSerialized(recording.original, false);
        const totalDuration = structuralBuffer.duration;

        STATE.viewStates[recording.id] = {
            currentStart: 0,
            currentEnd: totalDuration,
            targetStart: 0,
            targetEnd: totalDuration,
            zoomFactor: 1.0,
            animationActive: false,
            isDragging: false,
            dragStartSec: -1,
            dragEndSec: -1
        };

        if (!STATE.cachedPeaks[recording.id]) {
            ProWaveformEngine.generateCache(recording.id, structuralBuffer);
        }

        spawnCardViewportController(recording.id, canvas);

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault(); 

            const vs = STATE.viewStates[recording.id];
            if (!vs) return;

            const canvasWidth = canvas.offsetWidth;
            if (canvasWidth <= 0) return;

            const pointerRatio = e.offsetX / canvasWidth;
            const currentViewDuration = vs.targetEnd - vs.targetStart;
            const focalTime = vs.targetStart + (pointerRatio * currentViewDuration);

            let nextZoom = vs.zoomFactor;
            if (e.deltaY < 0) {
                nextZoom *= (1.0 + APP_CONFIG.ZOOM.SENSITIVITY);
            } else {
                nextZoom /= (1.0 + APP_CONFIG.ZOOM.SENSITIVITY);
            }

            if (nextZoom <= 1.005) {
                vs.zoomFactor = 1.0;
                vs.targetStart = 0;
                vs.targetEnd = totalDuration;
                spawnCardViewportController(recording.id, canvas);
                return;
            }

            const targetDuration = totalDuration / nextZoom;
            if (targetDuration < APP_CONFIG.ZOOM.MIN_WINDOW_DURATION) return; 

            vs.zoomFactor = nextZoom;

            let nextStart = focalTime - (pointerRatio * targetDuration);
            let nextEnd = nextStart + targetDuration;

            if (nextStart < 0) {
                nextEnd -= nextStart;
                nextStart = 0;
            }
            if (nextEnd > totalDuration) {
                nextStart -= (nextEnd - totalDuration);
                nextEnd = totalDuration;
            }

            vs.targetStart = Math.max(0, nextStart);
            vs.targetEnd = Math.min(totalDuration, nextEnd);

            spawnCardViewportController(recording.id, canvas);
        }, { passive: false });

        let isDragging = false;
        let dragStartX = 0;

        canvas.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            const vs = STATE.viewStates[recording.id];
            if (!vs) return;

            stopPlayback();
            resetPlaybackState();

            isDragging = true;
            vs.isDragging = true;
            dragStartX = e.offsetX;
            canvas.setPointerCapture(e.pointerId);
            spawnCardViewportController(recording.id, canvas);
        });

        canvas.addEventListener('pointermove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
            
            const vs = STATE.viewStates[recording.id];
            if (!vs) return;

            const currentX = e.offsetX;
            const canvasWidth = canvas.offsetWidth;
            const viewDuration = vs.currentEnd - vs.currentStart;
            
            const startX = Math.min(dragStartX, currentX);
            const endX = Math.max(dragStartX, currentX);
            
            vs.dragStartSec = vs.currentStart + (startX / canvasWidth) * viewDuration;
            vs.dragEndSec = vs.currentStart + (endX / canvasWidth) * viewDuration;
        });

        const handlePointerEnd = (e) => {
            if (!isDragging) return;
            e.preventDefault();
            isDragging = false;

            const vs = STATE.viewStates[recording.id];
            if (!vs) return;
            vs.isDragging = false;
            canvas.releasePointerCapture(e.pointerId);

            const finalX = e.offsetX;
            const canvasWidth = canvas.offsetWidth;
            const viewDuration = vs.currentEnd - vs.currentStart;

            const startX = Math.min(dragStartX, finalX);
            const endX = Math.max(dragStartX, finalX);
            const distance = Math.abs(dragStartX - finalX);

            const activeRecording = STATE.allRecordings.find(r => r.id === recording.id);
            if (!activeRecording) return;

            const finalStartSec = vs.currentStart + (startX / canvasWidth) * viewDuration;
            const finalEndSec = vs.currentStart + (endX / canvasWidth) * viewDuration;

            vs.dragStartSec = -1;
            vs.dragEndSec = -1;

            if (distance < APP_CONFIG.MIN_LOOP_DRAG_DISTANCE) {
                const seekSeconds = vs.currentStart + (finalX / canvasWidth) * viewDuration;
                startPlayback(recording.id, activeRecording.isReversed, seekSeconds, 0, 0, activeRecording.speed || 1);
            } else {
                startPlayback(recording.id, activeRecording.isReversed, finalStartSec, finalStartSec, finalEndSec, activeRecording.speed || 1);
            }
            spawnCardViewportController(recording.id, canvas);
        };

        canvas.addEventListener('pointerup', handlePointerEnd);
        canvas.addEventListener('pointerleave', handlePointerEnd);

        playBtn.addEventListener('click', () => {
            debounce('togglePlayPause', 'playback', async () => {
                togglePlayPause(recording.id);
                spawnCardViewportController(recording.id, canvas);
            });
        });

        reverseBtn.addEventListener('click', () => {
            debounce('toggleReverse', 'playback', async () => {
                await toggleReverse(recording.id);
                spawnCardViewportController(recording.id, canvas);
            });
        });

        deleteBtn.addEventListener('click', () => {
            if (confirm(I18N.get('confirm_delete_segment'))) {
                deleteRecording(recording.id);
            }
        });

        exportBtn.addEventListener('click', () => {
            debounce('exportRecording', 'export', async () => {
                await exportRecording(recording.id);
            });
        });

        speedUpBtn.addEventListener('click', () => {
            const currentIdx = APP_CONFIG.SPEED_LEVELS.indexOf(recording.speed || 1);
            if (currentIdx < APP_CONFIG.SPEED_LEVELS.length - 1) {
                updatePlaybackSpeed(recording.id, currentIdx + 1);
                spawnCardViewportController(recording.id, canvas);
            }
        });

        speedDownBtn.addEventListener('click', () => {
            const currentIdx = APP_CONFIG.SPEED_LEVELS.indexOf(recording.speed || 1);
            if (currentIdx > 0) {
                updatePlaybackSpeed(recording.id, currentIdx - 1);
                spawnCardViewportController(recording.id, canvas);
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
            ELEMENTS.statusMessage.textContent = I18N.get('msg_tracks_loaded', { count: recordings.length });
        } catch (error) {
            handleError(error, 'Load Sequence');
        }
    }

    async function deleteRecording(recordingId) {
        try {
            if (STATE.currentPlayback.id === recordingId) {
                resetPlaybackState();
            }
            await deleteRecordingFromDB(recordingId);
            STATE.allRecordings = STATE.allRecordings.filter(r => r.id !== recordingId);
            delete STATE.cachedPeaks[recordingId];
            delete STATE.viewStates[recordingId];
            
            document.querySelector(`.recording-card[data-id="${recordingId}"]`)?.remove();
            updateStorageStatus();
            ELEMENTS.statusMessage.textContent = I18N.get('status_track_removed');
        } catch (error) {
            handleError(error, 'De-allocation execution');
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

    function extractAudioSegment(buffer, startSec, endSec) {
        const sr = buffer.sampleRate;
        const startFrame = Math.max(0, Math.floor(startSec * sr));
        const endFrame = Math.min(buffer.length, Math.floor(endSec * sr));
        const newLength = Math.max(0, endFrame - startFrame);
        
        const out = STATE.audioContext.createBuffer(buffer.numberOfChannels, newLength, sr);
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            out.getChannelData(ch).set(buffer.getChannelData(ch).subarray(startFrame, endFrame));
        }
        return out;
    }

    async function resampleWithOffline(sourceBuffer, speed = 1) {
        if (Math.abs(speed - 1) < 1e-9) return sourceBuffer;
        const targetLength = Math.max(1, Math.ceil((sourceBuffer.duration / speed) * sourceBuffer.sampleRate));
        
        const offline = new OfflineAudioContext(sourceBuffer.numberOfChannels, targetLength, sourceBuffer.sampleRate);
        const src = offline.createBufferSource();
        src.buffer = sourceBuffer;
        src.playbackRate.value = speed;
        src.connect(offline.destination);
        src.start(0);
        
        return await offline.startRendering();
    }

    async function exportRecording(recordingId) {
        try {
            ELEMENTS.statusMessage.textContent = I18N.get('status_compiling');
            const recording = STATE.allRecordings.find(r => r.id === recordingId);
            if (!recording) throw new Error('Source array mapping missing.');

            let buffer = buildAudioBufferFromSerialized(recording.original, recording.isReversed);
            
            if (STATE.currentPlayback.id === recordingId && STATE.currentPlayback.loopEnd > STATE.currentPlayback.loopStart) {
                buffer = extractAudioSegment(buffer, STATE.currentPlayback.loopStart, STATE.currentPlayback.loopEnd);
            }

            const speed = recording.speed || 1;
            if (Math.abs(speed - 1) > 1e-9) {
                buffer = await resampleWithOffline(buffer, speed);
            }

            const wavBlob = convertAudioBufferToWavBlob(buffer);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const suffix = recording.isReversed ? 'reversed' : 'original';
            
            downloadBlob(wavBlob, `audio_${recordingId}_${suffix}_${timestamp}.wav`);
            ELEMENTS.statusMessage.textContent = I18N.get('status_export_complete');
        } catch (error) {
            handleError(error, 'Export File Render');
        } finally {
            STATE.activeOperations.export = false;
        }
    }

    function convertAudioBufferToWavBlob(buffer) {
        const numChannels = buffer.numberOfChannels;
        const sampleRate = buffer.sampleRate;
        const blockAlign = numChannels * 4; 
        const dataByteLength = buffer.length * blockAlign;
        const arrayBuffer = new ArrayBuffer(44 + dataByteLength);
        const view = new DataView(arrayBuffer);

        const writeString = (v, offset, str) => {
            for (let i = 0; i < str.length; i++) v.setUint8(offset + i, str.charCodeAt(i));
        };

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
        view.setUint16(34, 32, true); 
        writeString(view, 36, 'data');
        view.setUint32(40, dataByteLength, true);

        let offset = 44;
        const channels = [];
        for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));
        
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
        if (STATE.allRecordings.length >= APP_CONFIG.MAX_RECORDINGS) {
            showModal(I18N.get('msg_storage_limit_reached'), I18N.get('msg_purge_older'));
            return;
        }
        try {
            STATE.isRecording = true;
            STATE.recordingChunks = [];
            STATE.mediaStream = await captureTabAudio();
            STATE.mediaRecorder = new MediaRecorder(STATE.mediaStream);
            
            STATE.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) STATE.recordingChunks.push(event.data);
            };

            STATE.mediaRecorder.onstop = async () => {
                if (STATE.recordingChunks.length > 0) {
                    ELEMENTS.statusMessage.textContent = I18N.get('status_parsing_stream');
                    const rawBlob = new Blob(STATE.recordingChunks, { type: 'audio/webm; codecs=opus' });
                    const compiledAudio = await processAudioBuffer(rawBlob);
                    
                    const profile = {
                        id: 'rec-' + Date.now(),
                        createdAt: Date.now(),
                        duration: compiledAudio.duration,
                        original: compiledAudio.original,
                        isReversed: false,
                        speed: 1
                    };

                    await saveRecording(profile);
                    STATE.allRecordings.unshift(profile);
                    
                    const card = createRecordingCard(profile);
                    ELEMENTS.recordingsGrid.prepend(card);
                    updateStorageStatus();
                    ELEMENTS.statusMessage.textContent = I18N.get('status_recorded_cleanly');
                }
                resetRecordingState();
            };

            STATE.mediaRecorder.start();
            setupVisualizer(STATE.mediaStream);
            
            ELEMENTS.recordBtn.querySelector('span').textContent = I18N.get('btn_stop_recording');
            ELEMENTS.recordBtn.classList.add('recording');
            ELEMENTS.statusMessage.textContent = I18N.get('recording_status');
        } catch (error) {
            handleError(error, 'Capture Engine Initialization');
            resetRecordingState();
        }
    }

    function stopRecording() {
        if (STATE.isRecording && STATE.mediaRecorder && STATE.mediaRecorder.state !== 'inactive') {
            STATE.mediaRecorder.stop();
        }
    }

    function resetRecordingState() {
        STATE.isRecording = false;
        if (STATE.mediaStream) {
            STATE.mediaStream.getTracks().forEach(track => track.stop());
            STATE.mediaStream = null;
        }
        if (STATE.audioElement) {
            STATE.audioElement.srcObject = null;
            STATE.audioElement = null;
        }
        STATE.recordingChunks = [];
        setupVisualizer(null);
        ELEMENTS.recordBtn.querySelector('span').textContent = I18N.get('btn_start_recording');
        ELEMENTS.recordBtn.classList.remove('recording');
    }

    function setupVisualizer(stream) {
        if (!stream) {
            if (STATE.visualizerAnimationFrameId) cancelAnimationFrame(STATE.visualizerAnimationFrameId);
            if (STATE.mediaStreamSource) STATE.mediaStreamSource.disconnect();
            if (STATE.analyserNode) STATE.analyserNode.disconnect();
            
            STATE.visualizerAnimationFrameId = null;
            STATE.mediaStreamSource = null;
            STATE.analyserNode = null;
            
            const ctx = ELEMENTS.visualizer.getContext('2d');
            ctx.clearRect(0, 0, ELEMENTS.visualizer.width, ELEMENTS.visualizer.height);
            return;
        }

        STATE.mediaStreamSource = STATE.audioContext.createMediaStreamSource(stream);
        STATE.analyserNode = STATE.audioContext.createAnalyser();
        STATE.analyserNode.fftSize = 256;
        STATE.mediaStreamSource.connect(STATE.analyserNode);

        const dataArray = new Uint8Array(STATE.analyserNode.frequencyBinCount);
        const ctx = ELEMENTS.visualizer.getContext('2d');
        
        const draw = () => {
            if (!STATE.analyserNode) return;
            STATE.analyserNode.getByteFrequencyData(dataArray);
            
            const width = ELEMENTS.visualizer.width;
            const height = ELEMENTS.visualizer.height;
            const barWidth = (width / dataArray.length) * 2.5;
            
            ctx.clearRect(0, 0, width, height);
            ctx.fillStyle = '#ffffff';
            
            let x = 0;
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
        const isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.documentElement.classList.toggle('theme-light', !isDark);
    }

    function updateStorageStatus() {
        if (!ELEMENTS.storageStatus) return;
        const currentCount = STATE.allRecordings.length;
        ELEMENTS.storageStatus.textContent = `Used: ${currentCount}/${APP_CONFIG.MAX_RECORDINGS}`;
        
        ELEMENTS.storageStatus.classList.toggle('warning-yellow', currentCount >= APP_CONFIG.RECORDING_WARNING_THRESHOLD_YELLOW && currentCount < APP_CONFIG.RECORDING_WARNING_THRESHOLD_RED);
        ELEMENTS.storageStatus.classList.toggle('warning-red', currentCount >= APP_CONFIG.RECORDING_WARNING_THRESHOLD_RED);
    }

    async function checkAndShowWarningModal() {
        if (!navigator.storage || !navigator.storage.estimate) return;
        try {
            const estimate = await navigator.storage.estimate();
            if (estimate.usage >= APP_CONFIG.STORAGE_WARNING_THRESHOLD) {
                showModal(I18N.get('msg_storage_threshold_alert'), I18N.get('msg_persistent_memory_near_limit'));
            }
        } catch (e) {}
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
            window.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
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

        if (ELEMENTS.closeSettingsBtn && ELEMENTS.settingsModal) {
            ELEMENTS.closeSettingsBtn.addEventListener('click', () => {
                ELEMENTS.settingsModal.style.display = 'none';
            });
        }

        if (ELEMENTS.settingsModalBtn && ELEMENTS.settingsModal) {
            ELEMENTS.settingsModalBtn.addEventListener('click', () => {
                ELEMENTS.settingsModal.style.display = 'block';
            });
        }
    }

    function formatDuration(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    }

    function handleError(error, context) {
        console.error(`Error in ${context}:`, error);
        if (ELEMENTS.statusMessage) {
            ELEMENTS.statusMessage.textContent = I18N.get('error_prefix', { message: error.message });
        }
        updateAllPlaybackCardUIs();
    }

    initExtension();
});