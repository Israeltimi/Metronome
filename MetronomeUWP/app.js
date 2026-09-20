/**
 * Metronome for Windows 10 Mobile (Lumia Edition)
 * Background-only silent notification, native keyboard editing, 1-click BPM change, 2px tick inset
 */

(function () {
    "use strict";

    // Global error shield
    window.onerror = function (msg, url, line, col, error) {
        console.warn("Metronome error handled:", msg, "line:", line);
        return true;
    };

    // --- State & Constants ---
    const STATE = {
        beats: 4,               // 1..8
        subdivisions: 1,        // 1..4
        tempo: 80,              // 30..252 BPM
        gaps: new Set(),        // Set of muted beat numbers (1-indexed)
        emphasizeFirstBeat: true,
        sound: "square_wave",   // "square_wave", "sine_wave", "risset_drum", "pluck"
        nightMode: "system",    // "system", "dark", "light"
        playing: false
    };

    const SOUND_OPTIONS = [
        { id: "square_wave", label: "Square wave" },
        { id: "sine_wave", label: "Sine wave" },
        { id: "risset_drum", label: "Risset drum" },
        { id: "pluck", label: "Pluck" }
    ];

    const NIGHT_MODE_OPTIONS = [
        { id: "system", label: "Follow system" },
        { id: "dark", label: "Dark" },
        { id: "light", label: "Light" }
    ];

    const TEMPO_MARKINGS = [
        { min: 0, max: 59, label: "Largo" },
        { min: 60, max: 65, label: "Larghetto" },
        { min: 66, max: 75, label: "Adagio" },
        { min: 76, max: 107, label: "Andante" },
        { min: 108, max: 119, label: "Moderato" },
        { min: 120, max: 167, label: "Allegro" },
        { min: 168, max: 199, label: "Presto" },
        { min: 200, max: 252, label: "Prestissimo" }
    ];

    const PLAY_SVG = '<svg viewBox="0 0 24 24" width="34" height="34"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
    const PAUSE_SVG = '<svg viewBox="0 0 24 24" width="34" height="34"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';

    // Slider Controllers
    let sliderBeatsCtrl = null;
    let sliderSubdivisionsCtrl = null;
    let sliderTempoCtrl = null;

    // --- Audio Engine ---
    let audioCtx = null;
    const soundBuffers = {};
    let schedulerTimer = null;
    let nextTickTime = 0.0;
    let currentTickIndex = 0;
    const LOOKAHEAD_MS = 25.0;
    const SCHEDULE_AHEAD_SEC = 0.1;

    let bgAudioKeeper = null;
    let smtc = null;
    let uiSettings = null;

    // --- Native Windows 10 Mobile Features ---
    function initWindowsMobileIntegration() {
        // Hardware Back Button
        try {
            if (window.Windows && Windows.Phone && Windows.Phone.UI && Windows.Phone.UI.Input) {
                Windows.Phone.UI.Input.HardwareButtons.addEventListener("backpressed", function (e) {
                    const settingsScreen = document.getElementById("screen-settings");
                    const modalDialog = document.getElementById("modal-dialog");
                    const modalInfo = document.getElementById("modal-info");

                    if (modalDialog.classList.contains("open")) {
                        closeDialog();
                        e.handled = true;
                    } else if (modalInfo.classList.contains("open")) {
                        closeInfoDialog();
                        e.handled = true;
                    } else if (settingsScreen.classList.contains("active")) {
                        closeSettings();
                        e.handled = true;
                    }
                });
            }
        } catch (e) {}

        // System Media Transport Controls (Lock screen & Volume flyout)
        try {
            if (window.Windows && Windows.Media && Windows.Media.SystemMediaTransportControls) {
                smtc = Windows.Media.SystemMediaTransportControls.getForCurrentView();
                smtc.isPlayEnabled = true;
                smtc.isPauseEnabled = true;
                smtc.isStopEnabled = true;
                smtc.playbackStatus = Windows.Media.MediaPlaybackStatus.closed;

                smtc.addEventListener("buttonpressed", function (e) {
                    const btn = Windows.Media.SystemMediaTransportControlsButton;
                    if (e.button === btn.play) {
                        startMetronome();
                    } else if (e.button === btn.pause || e.button === btn.stop) {
                        stopMetronome();
                    }
                });
            }
        } catch (e) {}

        // Native System Theme Detection (for "Follow System")
        try {
            if (window.Windows && Windows.UI && Windows.UI.ViewManagement && Windows.UI.ViewManagement.UISettings) {
                uiSettings = new Windows.UI.ViewManagement.UISettings();
                uiSettings.addEventListener("colorvalueschanged", function () {
                    if (STATE.nightMode === "system") {
                        applyTheme("system");
                    }
                });
            }
        } catch (e) {}

        // App Activation from Toast Notification
        try {
            if (window.Windows && Windows.UI && Windows.UI.WebUI && Windows.UI.WebUI.WebUIApplication) {
                Windows.UI.WebUI.WebUIApplication.addEventListener("activated", function (args) {
                    if (args && args.kind === Windows.ApplicationModel.Activation.ActivationKind.toastNotification) {
                        stopMetronome();
                    }
                });
            }
        } catch (e) {}

        // Notification only when minimized
        document.addEventListener("visibilitychange", function () {
            if (document.hidden) {
                if (STATE.playing) {
                    showSilentNotification(STATE.tempo, STATE.beats);
                }
            } else {
                clearSilentNotification();
            }
        });

        // Status bar color
        try {
            if (window.Windows && Windows.UI && Windows.UI.ViewManagement && Windows.UI.ViewManagement.StatusBar) {
                const statusBar = Windows.UI.ViewManagement.StatusBar.getForCurrentView();
                statusBar.backgroundColor = { a: 255, r: 19, g: 19, b: 22 };
                statusBar.backgroundOpacity = 1;
            }
        } catch (e) {}
    }

    function getSystemTheme() {
        try {
            if (uiSettings) {
                const bg = uiSettings.getColorValue(Windows.UI.ViewManagement.UIColorType.background);
                const luma = 0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b;
                return luma < 128 ? "dark" : "light";
            }
        } catch (e) {}
        return "dark";
    }

    // --- Silent Notification (Shown only when app is minimized, sits in Action Center) ---
    function showSilentNotification(tempo, beats) {
        try {
            if (!window.Windows || !Windows.UI || !Windows.UI.Notifications) return;

            const notifications = Windows.UI.Notifications;
            const xmlString = `
<toast scenario="reminder">
  <audio silent="true"/>
  <visual>
    <binding template="ToastGeneric">
      <text>Metronome</text>
      <text>Playing at ${tempo} BPM (${beats} beats)</text>
    </binding>
  </visual>
  <actions>
    <action content="Stop" arguments="stop" activationType="foreground"/>
  </actions>
</toast>`;

            const xmlDoc = new Windows.Data.Xml.Dom.XmlDocument();
            xmlDoc.loadXml(xmlString);

            const toast = new notifications.ToastNotification(xmlDoc);
            toast.tag = "metronome_active";
            toast.group = "playback";
            toast.suppressPopup = true; // Sits silently in Action Center without popup banner

            toast.addEventListener("activated", function () {
                stopMetronome();
            });

            const notifier = notifications.ToastNotificationManager.createToastNotifier();
            notifier.show(toast);
        } catch (e) {}
    }

    function clearSilentNotification() {
        try {
            if (!window.Windows || !Windows.UI || !Windows.UI.Notifications) return;
            const history = Windows.UI.Notifications.ToastNotificationManager.history;
            history.remove("metronome_active", "playback");
        } catch (e) {}
    }

    function triggerHaptic() {
        try {
            if (navigator.vibrate) {
                navigator.vibrate(10);
            }
        } catch (e) {}
    }

    // --- Audio Engine ---
    function initAudio() {
        if (!audioCtx) {
            try {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                audioCtx = new AudioContextClass();
            } catch (e) {}
        }
        if (audioCtx && audioCtx.state === "suspended") {
            try { audioCtx.resume(); } catch (e) {}
        }
    }

    function decodeAudioSafe(ctx, arrayBuffer) {
        return new Promise((resolve) => {
            try {
                let resolved = false;
                const promise = ctx.decodeAudioData(
                    arrayBuffer,
                    (decoded) => {
                        if (!resolved) {
                            resolved = true;
                            resolve(decoded);
                        }
                    },
                    () => {
                        if (!resolved) {
                            resolved = true;
                            resolve(null);
                        }
                    }
                );
                if (promise && typeof promise.then === "function") {
                    promise.then((decoded) => {
                        if (!resolved) {
                            resolved = true;
                            resolve(decoded);
                        }
                    }).catch(() => {
                        if (!resolved) {
                            resolved = true;
                            resolve(null);
                        }
                    });
                }
            } catch (err) {
                resolve(null);
            }
        });
    }

    async function loadSoundBuffer(soundKey) {
        if (soundBuffers[soundKey]) return soundBuffers[soundKey];
        try {
            const response = await fetch(`sounds/${soundKey}.wav`);
            const arrayBuffer = await response.arrayBuffer();
            const decoded = await decodeAudioSafe(audioCtx, arrayBuffer);
            if (decoded) {
                soundBuffers[soundKey] = decoded;
            }
            return decoded;
        } catch (e) {
            return null;
        }
    }

    async function preloadAllSounds() {
        initAudio();
        if (!audioCtx) return;
        const soundTypes = ["square_wave", "sine_wave", "risset_drum", "pluck"];
        const tickTypes = ["strong", "weak", "sub"];

        for (const s of soundTypes) {
            for (const t of tickTypes) {
                loadSoundBuffer(`${s}_${t}`);
            }
        }
    }

    function playTickSound(time, tickType, isGap) {
        if (isGap) return;
        if (!audioCtx) return;

        try {
            const soundKey = `${STATE.sound}_${tickType}`;
            const buffer = soundBuffers[soundKey];

            if (buffer) {
                const source = audioCtx.createBufferSource();
                source.buffer = buffer;
                source.connect(audioCtx.destination);
                source.start(time);
            } else {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.connect(gain);
                gain.connect(audioCtx.destination);

                let freq = 1200;
                if (tickType === "strong") freq = 1600;
                else if (tickType === "sub") freq = 800;

                osc.frequency.setValueAtTime(freq, time);
                gain.gain.setValueAtTime(0.8, time);
                gain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);

                osc.start(time);
                osc.stop(time + 0.045);
            }
        } catch (e) {}
    }

    function scheduleTicks() {
        if (!STATE.playing || !audioCtx) return;

        try {
            while (nextTickTime < audioCtx.currentTime + SCHEDULE_AHEAD_SEC) {
                const subdivisions = STATE.subdivisions;
                const beats = STATE.beats;
                const emphasizeFirstBeat = STATE.emphasizeFirstBeat;

                const currentBeat = (Math.floor(currentTickIndex / subdivisions) % beats) + 1;
                const isFirstBeat = (currentTickIndex % (beats * subdivisions)) === 0;
                const isMainBeat = (currentTickIndex % subdivisions) === 0;

                let tickType = "sub";
                if (emphasizeFirstBeat && isFirstBeat) {
                    tickType = "strong";
                } else if (isMainBeat) {
                    tickType = "weak";
                }

                const isGap = STATE.gaps.has(currentBeat);

                playTickSound(nextTickTime, tickType, isGap);

                const scheduleTimeMs = (nextTickTime - audioCtx.currentTime) * 1000;
                const beatToAnimate = currentBeat;
                const isSub = (tickType === "sub");

                if (!isSub) {
                    setTimeout(() => {
                        if (STATE.playing) {
                            flashBeatDot(beatToAnimate);
                        }
                    }, Math.max(0, scheduleTimeMs));
                }

                const periodSec = 60.0 / (STATE.tempo * subdivisions);
                nextTickTime += periodSec;
                currentTickIndex++;
            }
        } catch (err) {}
    }

    function updatePlayPauseUI() {
        const container = document.getElementById("play-pause-icon");
        if (container) {
            container.innerHTML = STATE.playing ? PAUSE_SVG : PLAY_SVG;
        }
    }

    function startMetronome() {
        try {
            STATE.playing = true;
            updatePlayPauseUI();

            initAudio();
            currentTickIndex = 0;
            nextTickTime = (audioCtx ? audioCtx.currentTime : 0) + 0.05;

            if (bgAudioKeeper) {
                try { bgAudioKeeper.play(); } catch (e) {}
            }

            if (smtc && window.Windows) {
                try { smtc.playbackStatus = Windows.Media.MediaPlaybackStatus.playing; } catch (e) {}
            }

            // Only show notification if minimized
            if (document.hidden) {
                showSilentNotification(STATE.tempo, STATE.beats);
            }

            if (schedulerTimer) clearInterval(schedulerTimer);
            schedulerTimer = setInterval(scheduleTicks, LOOKAHEAD_MS);
        } catch (e) {
            console.error("Start error:", e);
        }
    }

    function stopMetronome() {
        try {
            STATE.playing = false;
            updatePlayPauseUI();

            if (schedulerTimer) {
                clearInterval(schedulerTimer);
                schedulerTimer = null;
            }

            if (bgAudioKeeper) {
                try { bgAudioKeeper.pause(); } catch (e) {}
            }

            if (smtc && window.Windows) {
                try { smtc.playbackStatus = Windows.Media.MediaPlaybackStatus.paused; } catch (e) {}
            }

            clearSilentNotification();
            clearBeatBlinks();
        } catch (e) {
            console.error("Stop error:", e);
        }
    }

    // --- Drum Button: Immediate BPM Change on Tap 1 + Rhythmic Tap Tempo on Tap 2+ ---
    const tapTimes = [];
    const TAP_TIMEOUT_MS = 2500;
    const TEMPO_STEPS = [60, 72, 80, 92, 100, 108, 120, 128, 136, 144, 160];

    function handleTapTempo() {
        triggerHaptic();

        // Bounce animation on button
        const drumBtn = document.getElementById("btn-tempo-tap");
        if (drumBtn) {
            drumBtn.style.transform = "scale(0.85)";
            setTimeout(() => { drumBtn.style.transform = ""; }, 100);
        }

        const now = performance.now();

        // If it's been more than 2.5s since last tap -> This is a fresh 1-click action!
        // Immediately change to a new BPM on the very first click!
        if (tapTimes.length === 0 || (now - tapTimes[tapTimes.length - 1]) > TAP_TIMEOUT_MS) {
            tapTimes.length = 0;
            tapTimes.push(now);

            // Immediately switch to a new tempo
            let next = TEMPO_STEPS[Math.floor(Math.random() * TEMPO_STEPS.length)];
            if (next === STATE.tempo) {
                next = (next >= 140) ? 80 : (next + 16);
            }
            setTempo(next);
            return;
        }

        // Tapped in rhythmic succession: calculate exact tapped BPM!
        tapTimes.push(now);
        while (tapTimes.length > 5) {
            tapTimes.shift();
        }

        let totalInterval = 0;
        for (let i = 1; i < tapTimes.length; i++) {
            totalInterval += (tapTimes[i] - tapTimes[i - 1]);
        }
        const avgIntervalMs = totalInterval / (tapTimes.length - 1);
        const calculatedBpm = Math.round(60000 / avgIntervalMs);
        setTempo(Math.min(252, Math.max(30, calculatedBpm)));
    }

    // --- State Setters & UI Sync ---
    let saveTimeout = null;
    function debouncedSave() {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(saveSettings, 300);
    }

    function setBeats(val) {
        val = parseInt(val, 10);
        if (isNaN(val) || val < 1 || val > 8) return;
        STATE.beats = val;

        for (const g of Array.from(STATE.gaps)) {
            if (g > val) STATE.gaps.delete(g);
        }

        if (sliderBeatsCtrl) sliderBeatsCtrl.setValue(val);
        const input = document.getElementById("input-beats");
        if (input && document.activeElement !== input) {
            input.value = val;
        }
        renderBeatDots();
        debouncedSave();

        if (STATE.playing && document.hidden) {
            showSilentNotification(STATE.tempo, STATE.beats);
        }
    }

    function setSubdivisions(val) {
        val = parseInt(val, 10);
        if (isNaN(val) || val < 1 || val > 4) return;
        STATE.subdivisions = val;

        if (sliderSubdivisionsCtrl) sliderSubdivisionsCtrl.setValue(val);
        const input = document.getElementById("input-subdivisions");
        if (input && document.activeElement !== input) {
            input.value = val;
        }
        debouncedSave();
    }

    function setTempo(val) {
        val = parseInt(val, 10);
        if (isNaN(val) || val < 30 || val > 252) return;
        STATE.tempo = val;

        if (sliderTempoCtrl) sliderTempoCtrl.setValue(val);
        const input = document.getElementById("input-tempo");
        if (input && document.activeElement !== input) {
            input.value = val;
        }

        const marking = TEMPO_MARKINGS.find(m => val >= m.min && val <= m.max);
        const markingLabel = document.getElementById("label-tempo-marking");
        if (markingLabel) {
            markingLabel.textContent = marking ? marking.label : "";
        }
        debouncedSave();

        if (STATE.playing && document.hidden) {
            showSilentNotification(STATE.tempo, STATE.beats);
        }
    }

    function changeTempo(delta) {
        triggerHaptic();
        setTempo(STATE.tempo + delta);
    }

    function toggleGap(beatNumber) {
        triggerHaptic();
        if (STATE.gaps.has(beatNumber)) {
            STATE.gaps.delete(beatNumber);
        } else {
            STATE.gaps.add(beatNumber);
        }
        renderBeatDots();
        saveSettings();
    }

    function setEmphasizeFirstBeat(val) {
        STATE.emphasizeFirstBeat = !!val;
        const sw = document.getElementById("switch-emphasize");
        if (sw) sw.checked = STATE.emphasizeFirstBeat;
        saveSettings();
    }

    function setSound(soundId) {
        STATE.sound = soundId;
        const opt = SOUND_OPTIONS.find(o => o.id === soundId);
        if (opt) {
            const label = document.getElementById("label-current-sound");
            if (label) label.textContent = opt.label;
        }
        saveSettings();
    }

    function setNightMode(mode) {
        STATE.nightMode = mode;
        const opt = NIGHT_MODE_OPTIONS.find(o => o.id === mode);
        if (opt) {
            const label = document.getElementById("label-current-night-mode");
            if (label) label.textContent = opt.label;
        }
        applyTheme(mode);
        saveSettings();
    }

    function applyTheme(mode) {
        document.body.classList.remove("theme-light", "theme-dark");
        if (mode === "dark") {
            document.body.classList.add("theme-dark");
        } else if (mode === "light") {
            document.body.classList.add("theme-light");
        } else {
            const resolved = getSystemTheme();
            document.body.classList.add(resolved === "dark" ? "theme-dark" : "theme-light");
        }
    }

    // --- Adaptive Beat Dots ---
    function renderBeatDots() {
        const container = document.getElementById("tick-visualization-container");
        if (!container) return;
        container.innerHTML = "";

        const n = STATE.beats;
        let size = 48;
        if (n === 5) size = 40;
        else if (n === 6) size = 34;
        else if (n === 7) size = 30;
        else if (n >= 8) size = 26;

        for (let b = 1; b <= n; b++) {
            const dot = document.createElement("div");
            dot.className = "beat-dot";
            dot.id = `beat-dot-${b}`;
            dot.style.width = size + "px";
            dot.style.height = size + "px";
            dot.style.minWidth = size + "px";
            dot.style.minHeight = size + "px";
            dot.style.maxWidth = size + "px";
            dot.style.maxHeight = size + "px";
            dot.style.margin = "0 2px";
            dot.setAttribute("data-beat", b);
            dot.setAttribute("role", "button");
            dot.setAttribute("aria-label", `Beat ${b}`);

            if (STATE.gaps.has(b)) {
                dot.classList.add("gap");
            }

            dot.addEventListener("click", () => toggleGap(b));
            container.appendChild(dot);
        }
    }

    function flashBeatDot(beatNumber) {
        const dot = document.getElementById(`beat-dot-${beatNumber}`);
        if (!dot) return;
        dot.classList.add("blinking");
        setTimeout(() => {
            dot.classList.remove("blinking");
        }, 160);
    }

    function clearBeatBlinks() {
        const dots = document.querySelectorAll(".beat-dot");
        for (let i = 0; i < dots.length; i++) {
            dots[i].classList.remove("blinking");
        }
    }

    // --- Smooth High-Performance M3 Slider Component ---
    function initM3Slider(sliderEl, onChange) {
        const min = parseFloat(sliderEl.dataset.min);
        const max = parseFloat(sliderEl.dataset.max);
        const step = parseFloat(sliderEl.dataset.step) || 1;
        const ticksCount = parseInt(sliderEl.dataset.ticks, 10) || 0;
        let currentValue = parseFloat(sliderEl.dataset.value) || min;

        const trackActive = sliderEl.querySelector(".m3-track-active");
        const thumb = sliderEl.querySelector(".m3-thumb");
        const ticksContainer = sliderEl.querySelector(".m3-ticks");
        const cachedTicks = [];

        if (ticksCount > 1 && ticksContainer) {
            ticksContainer.innerHTML = "";
            for (let i = 0; i < ticksCount; i++) {
                const tick = document.createElement("div");
                tick.className = "m3-tick";
                const valAtTick = min + (i / (ticksCount - 1)) * (max - min);
                const numVal = Math.round(valAtTick);
                tick.dataset.value = numVal;
                const pct = (i / (ticksCount - 1));
                // Increased extreme dots padding by 1px: 3px inset from edges
                tick.style.left = "calc(3px + (100% - 6px) * " + pct + ")";
                ticksContainer.appendChild(tick);
                cachedTicks.push({ el: tick, val: numVal });
            }
        }

        function updateTrackVisuals(f) {
            f = Math.max(0, Math.min(1, f));
            thumb.style.left = "calc((100% - 4px) * " + f + ")";

            if (f <= 0.001) {
                trackActive.style.width = "0px";
            } else if (f >= 0.999) {
                trackActive.style.width = "100%";
            } else {
                trackActive.style.width = "calc(2px + (100% - 4px) * " + f + ")";
            }
        }

        function updateVisuals(val) {
            const f = Math.max(0, Math.min(1, (val - min) / (max - min)));
            updateTrackVisuals(f);
            sliderEl.dataset.value = val;

            if (cachedTicks.length > 0) {
                for (let i = 0; i < cachedTicks.length; i++) {
                    cachedTicks[i].el.style.opacity = (cachedTicks[i].val === val) ? "0" : "1";
                }
            }
        }

        let isDragging = false;
        let cachedLeft = 0;
        let cachedWidth = 0;
        let pendingClientX = null;
        let rafId = null;

        function updateFromPointer(clientX) {
            if (cachedWidth <= 4) return;
            const usableWidth = cachedWidth - 4;
            const offsetX = Math.max(0, Math.min(usableWidth, clientX - (cachedLeft + 2)));
            const rawPct = Math.max(0, Math.min(1, offsetX / usableWidth));

            // 1. Continuous smooth visual gliding directly under the finger
            updateTrackVisuals(rawPct);

            // 2. Stepped value calculation for state
            const rawVal = min + rawPct * (max - min);
            let steppedVal = Math.round((rawVal - min) / step) * step + min;
            steppedVal = Math.max(min, Math.min(max, steppedVal));

            if (cachedTicks.length > 0) {
                for (let i = 0; i < cachedTicks.length; i++) {
                    cachedTicks[i].el.style.opacity = (cachedTicks[i].val === steppedVal) ? "0" : "1";
                }
            }

            if (steppedVal !== currentValue) {
                currentValue = steppedVal;
                sliderEl.dataset.value = steppedVal;
                if (onChange) onChange(steppedVal);
            }
        }

        function processPointerMove() {
            rafId = null;
            if (!isDragging || pendingClientX === null) return;
            updateFromPointer(pendingClientX);
        }

        function onPointerMove(e) {
            if (!isDragging) return;
            e.preventDefault();
            pendingClientX = e.clientX;
            if (rafId === null) {
                rafId = requestAnimationFrame(processPointerMove);
            }
        }

        function onPointerUp(e) {
            if (!isDragging) return;
            isDragging = false;
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            try { sliderEl.releasePointerCapture(e.pointerId); } catch (err) {}
            window.removeEventListener("pointermove", onPointerMove);
            window.removeEventListener("pointerup", onPointerUp);
            window.removeEventListener("pointercancel", onPointerUp);

            // Clean snap to discrete value upon release
            updateVisuals(currentValue);
            saveSettings();
        }

        sliderEl.addEventListener("pointerdown", (e) => {
            isDragging = true;
            e.preventDefault();
            try { sliderEl.setPointerCapture(e.pointerId); } catch (err) {}
            const rect = sliderEl.getBoundingClientRect();
            cachedLeft = rect.left;
            cachedWidth = rect.width;
            updateFromPointer(e.clientX);

            window.addEventListener("pointermove", onPointerMove, { passive: false });
            window.addEventListener("pointerup", onPointerUp);
            window.addEventListener("pointercancel", onPointerUp);
        });

        updateVisuals(currentValue);

        return {
            setValue: function (newVal) {
                if (isDragging) return; // Do not interrupt user's smooth continuous drag
                currentValue = Math.max(min, Math.min(max, newVal));
                updateVisuals(currentValue);
            },
            getValue: function () {
                return currentValue;
            }
        };
    }

    // --- Clean Manual Number Input (Safe from EdgeHTML IME compositor crashes) ---
    function bindNumberInput(inputEl, min, max, getVal, onCommit) {
        if (!inputEl) return;

        function commit() {
            let raw = inputEl.value.replace(/[^0-9]/g, "");
            if (!raw) {
                inputEl.value = getVal();
                return;
            }
            let val = parseInt(raw, 10);
            if (isNaN(val) || val < min) val = min;
            if (val > max) val = max;
            inputEl.value = val;
            onCommit(val);
        }

        inputEl.addEventListener("change", commit);
        inputEl.addEventListener("blur", commit);

        inputEl.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.keyCode === 13) {
                commit();
                this.blur();
            }
        });
    }

    // --- Long Press Button Helper ---
    function setupLongPressButton(btnEl, onShortClick, onLongAction) {
        if (!btnEl) return;
        let pressTimer = null;
        let isLongPress = false;
        let repeatInterval = null;

        function startPress(e) {
            e.preventDefault();
            isLongPress = false;
            triggerHaptic();

            pressTimer = setTimeout(() => {
                isLongPress = true;
                triggerHaptic();
                onLongAction();

                repeatInterval = setInterval(() => {
                    triggerHaptic();
                    onLongAction();
                }, 180);
            }, 500);
        }

        function endPress(e) {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
            if (repeatInterval) {
                clearInterval(repeatInterval);
                repeatInterval = null;
            }
            if (!isLongPress && e.type !== "pointercancel" && e.type !== "pointerleave") {
                onShortClick();
            }
        }

        btnEl.addEventListener("pointerdown", startPress);
        btnEl.addEventListener("pointerup", endPress);
        btnEl.addEventListener("pointercancel", endPress);
        btnEl.addEventListener("pointerleave", endPress);
    }

    // --- Navigation & Dialogs ---
    function openSettings() {
        document.getElementById("screen-metronome").classList.remove("active");
        document.getElementById("screen-settings").classList.add("active");
    }

    function closeSettings() {
        document.getElementById("screen-settings").classList.remove("active");
        document.getElementById("screen-metronome").classList.add("active");
    }

    function showDialog(title, options, currentId, onSelect) {
        const modal = document.getElementById("modal-dialog");
        const modalTitle = document.getElementById("modal-title");
        const optionsList = document.getElementById("modal-options-list");

        modalTitle.textContent = title;
        optionsList.innerHTML = "";

        options.forEach(opt => {
            const item = document.createElement("div");
            item.className = "modal-option" + (opt.id === currentId ? " selected" : "");
            item.innerHTML = `
                <div class="modal-option-radio"></div>
                <div class="modal-option-label">${opt.label}</div>
            `;
            item.addEventListener("click", () => {
                triggerHaptic();
                onSelect(opt.id);
                closeDialog();
            });
            optionsList.appendChild(item);
        });

        modal.classList.add("open");
    }

    function closeDialog() {
        document.getElementById("modal-dialog").classList.remove("open");
    }

    function showInfoDialog(title, bodyText) {
        document.getElementById("modal-info-title").textContent = title;
        document.getElementById("modal-info-body").textContent = bodyText;
        document.getElementById("modal-info").classList.add("open");
    }

    function closeInfoDialog() {
        document.getElementById("modal-info").classList.remove("open");
    }

    // --- Storage ---
    function saveSettings() {
        try {
            const data = {
                beats: STATE.beats,
                subdivisions: STATE.subdivisions,
                tempo: STATE.tempo,
                gaps: Array.from(STATE.gaps),
                emphasizeFirstBeat: STATE.emphasizeFirstBeat,
                sound: STATE.sound,
                nightMode: STATE.nightMode
            };
            localStorage.setItem("metronome_settings", JSON.stringify(data));
        } catch (e) {}
    }

    function loadSettings() {
        try {
            const raw = localStorage.getItem("metronome_settings");
            if (raw) {
                const data = JSON.parse(raw);
                if (data.beats) STATE.beats = data.beats;
                if (data.subdivisions) STATE.subdivisions = data.subdivisions;
                if (data.tempo) STATE.tempo = data.tempo;
                if (data.gaps) STATE.gaps = new Set(data.gaps);
                if (data.emphasizeFirstBeat !== undefined) STATE.emphasizeFirstBeat = data.emphasizeFirstBeat;
                if (data.sound) STATE.sound = data.sound;
                if (data.nightMode) STATE.nightMode = data.nightMode;
            }
        } catch (e) {}
    }

    // --- Initialization ---
    document.addEventListener("DOMContentLoaded", () => {
        initWindowsMobileIntegration();
        loadSettings();
        applyTheme(STATE.nightMode);

        bgAudioKeeper = document.getElementById("bg-audio-keeper");

        // Initialize Custom M3 Sliders
        sliderBeatsCtrl = initM3Slider(document.getElementById("slider-beats"), (val) => {
            setBeats(val);
        });

        sliderSubdivisionsCtrl = initM3Slider(document.getElementById("slider-subdivisions"), (val) => {
            setSubdivisions(val);
        });

        sliderTempoCtrl = initM3Slider(document.getElementById("slider-tempo"), (val) => {
            setTempo(val);
        });

        // Set initial values
        setBeats(STATE.beats);
        setSubdivisions(STATE.subdivisions);
        setTempo(STATE.tempo);
        setEmphasizeFirstBeat(STATE.emphasizeFirstBeat);
        setSound(STATE.sound);
        setNightMode(STATE.nightMode);
        updatePlayPauseUI();

        // Bind crash-free manual inputs
        bindNumberInput(document.getElementById("input-beats"), 1, 8, () => STATE.beats, (val) => setBeats(val));
        bindNumberInput(document.getElementById("input-subdivisions"), 1, 4, () => STATE.subdivisions, (val) => setSubdivisions(val));
        bindNumberInput(document.getElementById("input-tempo"), 30, 252, () => STATE.tempo, (val) => setTempo(val));

        // Action Buttons
        const btnPlayPause = document.getElementById("btn-play-pause");
        btnPlayPause.addEventListener("click", () => {
            triggerHaptic();
            if (STATE.playing) stopMetronome();
            else startMetronome();
        });

        const btnTempoDec = document.getElementById("btn-tempo-dec");
        setupLongPressButton(btnTempoDec, () => changeTempo(-1), () => changeTempo(-10));

        const btnTempoInc = document.getElementById("btn-tempo-inc");
        setupLongPressButton(btnTempoInc, () => changeTempo(1), () => changeTempo(10));

        const btnTempoTap = document.getElementById("btn-tempo-tap");
        btnTempoTap.addEventListener("click", handleTapTempo);

        // Settings Navigation
        document.getElementById("btn-open-settings").addEventListener("click", () => {
            triggerHaptic();
            openSettings();
        });

        document.getElementById("btn-back-from-settings").addEventListener("click", () => {
            triggerHaptic();
            closeSettings();
        });

        // Settings Items
        document.getElementById("switch-emphasize").addEventListener("change", (e) => {
            setEmphasizeFirstBeat(e.target.checked);
        });

        document.getElementById("item-sound").addEventListener("click", () => {
            showDialog("Sound", SOUND_OPTIONS, STATE.sound, (selectedId) => {
                setSound(selectedId);
            });
        });

        document.getElementById("item-night-mode").addEventListener("click", () => {
            showDialog("Theme", NIGHT_MODE_OPTIONS, STATE.nightMode, (selectedId) => {
                setNightMode(selectedId);
            });
        });

        document.getElementById("item-license").addEventListener("click", () => {
            showInfoDialog("License", "GNU General Public License v3.0\n\nThis program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.");
        });

        document.getElementById("item-licenses").addEventListener("click", () => {
            showInfoDialog("Third-party licenses", "Jetpack Compose (Apache 2.0)\nKotlin Coroutines (Apache 2.0)\nMaterial Symbols (Apache 2.0)\nFreeSound audio assets (Creative Commons 0)");
        });

        document.getElementById("item-source").addEventListener("click", (e) => {
            if (e) e.preventDefault();
            try {
                if (window.Windows && Windows.System && Windows.System.Launcher) {
                    Windows.System.Launcher.launchUriAsync(new Windows.Foundation.Uri("https://github.com/Israeltimi/Metronome"));
                } else {
                    window.open("https://github.com/Israeltimi/Metronome", "_blank");
                }
            } catch (err) {}
        });

        const itemAuthor = document.getElementById("item-author");
        if (itemAuthor) {
            itemAuthor.addEventListener("click", () => {
                showInfoDialog("Author", "Israel Oloruntimilehin\n\nDeveloper of the Windows 10 Mobile / Lumia port.");
            });
        }

        const itemCredits = document.getElementById("item-credits");
        if (itemCredits) {
            itemCredits.addEventListener("click", () => {
                showInfoDialog("Credits", "Inspired by the open-source Android Metronome by Philipp Bobek.");
            });
        }

        const itemDesc = document.getElementById("item-description");
        if (itemDesc) {
            itemDesc.addEventListener("click", () => {
                showInfoDialog("Metronome", "A simple metronome app for Windows Phone 10.");
            });
        }

        document.getElementById("btn-modal-cancel").addEventListener("click", closeDialog);
        document.getElementById("btn-modal-info-close").addEventListener("click", closeInfoDialog);

        document.getElementById("modal-dialog").addEventListener("click", (e) => {
            if (e.target.id === "modal-dialog") closeDialog();
        });
        document.getElementById("modal-info").addEventListener("click", (e) => {
            if (e.target.id === "modal-info") closeInfoDialog();
        });

        // Preload sounds on first touch
        window.addEventListener("pointerdown", () => {
            preloadAllSounds();
        }, { once: true });
    });
})();
