(() => {
  const els = {
    frontVideo: document.getElementById('frontVideo'),
    backVideo: document.getElementById('backVideo'),
    startBtn: document.getElementById('startBtn'),
    switchBtn: document.getElementById('switchBtn'),
    stopBtn: document.getElementById('stopBtn'),
    fakeCallBtn: document.getElementById('fakeCallBtn'),
    status: document.getElementById('status'),
    overlay: document.getElementById('callOverlay'),
    answerBtn: document.getElementById('answerBtn'),
    declineBtn: document.getElementById('declineBtn'),
    videoGrid: document.getElementById('videoGrid'),
    pipWrap: document.querySelector('.pip-wrap'),
  };

  function ensureVideoAttributes(v) {
    if (!v) return;
    try {
      v.setAttribute('playsinline', 'true');
      v.playsInline = true;
      v.muted = true;
    } catch {}
  }

  async function safePlay(v) {
    if (!v) return;
    try {
      await v.play();
    } catch (e) {
      // Some mobile browsers require user gesture; we already are in a gesture for start.
      // If still failing, ignore.
      console.warn('video.play() failed', e);
    }
  }

  function updatePipVisibility() {
    if (!els.pipWrap) return;
    if (state.dualSupported) {
      els.pipWrap.classList.remove('hidden');
    } else {
      els.pipWrap.classList.add('hidden');
    }
  }

  const state = {
    frontStream: null,
    backStream: null,
    singleStream: null,
    singleFacing: 'environment', // 'user' or 'environment'
    dualSupported: false,
    wakeLock: null,
    ringtone: null,
    ringing: false,
    vibrationInterval: null,
  };

  function setStatus(msg) {
    els.status.textContent = msg;
    console.log('[status]', msg);
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener?.('release', () => console.log('WakeLock released'));
        console.log('WakeLock acquired');
      }
    } catch (e) {
      console.warn('WakeLock error', e);
    }
  }

  async function enumerateCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter(d => d.kind === 'videoinput');
      return cams;
    } catch (e) {
      console.warn('enumerateDevices failed', e);
      return [];
    }
  }

  async function getFacingDeviceId(facing) {
    const cams = await enumerateCameras();
    // Try to pick by label, otherwise fall back to first/last
    const byLabel = cams.find(c => c.label.toLowerCase().includes(facing === 'user' ? 'front' : 'back'))
      || cams.find(c => c.label.toLowerCase().includes(facing === 'user' ? 'user' : 'environment'));
    if (byLabel) return byLabel.deviceId;
    if (cams.length === 0) return undefined;
    return facing === 'user' ? cams[0].deviceId : (cams[cams.length - 1].deviceId);
  }

  async function waitForVideoRender(videoEl, timeoutMs = 1800) {
    return new Promise((resolve) => {
      let done = false;
      const clearAll = () => {
        done = true;
        videoEl.removeEventListener('loadedmetadata', onOk);
        videoEl.removeEventListener('canplay', onOk);
      };
      const onOk = () => {
        if (done) return;
        if ((videoEl.videoWidth || 0) > 0 && (videoEl.videoHeight || 0) > 0) {
          clearAll();
          resolve(true);
        }
      };
      videoEl.addEventListener('loadedmetadata', onOk);
      videoEl.addEventListener('canplay', onOk);
      const t = setTimeout(() => {
        if (done) return;
        clearAll();
        resolve(false);
      }, timeoutMs);
    });
  }

  async function tryStartDual() {
    // Attempt to open two streams simultaneously; many mobile browsers restrict this.
    try {
      // Prime permission to reveal device labels on some browsers (iOS/Android)
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        tmp.getTracks().forEach(t => t.stop());
      } catch (e) {
        // Ignore; we'll still try facingMode fallback
      }

      const frontId = await getFacingDeviceId('user');
      const backId = await getFacingDeviceId('environment');

      // Open back (main) first with higher res, then front (PiP) lighter to reduce conflicts
      const backCommon = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } };
      const frontLight = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 24 } };

      let backConstraints = backId
        ? { ...backCommon, deviceId: { exact: backId } }
        : { ...backCommon, facingMode: 'environment' };
      let frontConstraints = frontId
        ? { ...frontLight, deviceId: { exact: frontId } }
        : { ...frontLight, facingMode: 'user' };

      const backStream = await navigator.mediaDevices.getUserMedia({ video: backConstraints, audio: false });
      ensureVideoAttributes(els.backVideo);
      els.backVideo.srcObject = backStream;
      await safePlay(els.backVideo);

      // Try front
      let frontStream;
      try {
        frontStream = await navigator.mediaDevices.getUserMedia({ video: frontConstraints, audio: false });
      } catch (e1) {
        // Retry with exact facingMode as a fallback
        try {
          frontConstraints = { ...frontLight, facingMode: { exact: 'user' } };
          frontStream = await navigator.mediaDevices.getUserMedia({ video: frontConstraints, audio: false });
        } catch (e2) {
          // Could not open front; cleanup and fail dual
          backStream.getTracks().forEach(t => t.stop());
          throw e2;
        }
      }

      ensureVideoAttributes(els.frontVideo);
      els.frontVideo.srcObject = frontStream;
      await safePlay(els.frontVideo);

      // Validate that PiP actually renders; if not, treat as failure
      const okMain = await waitForVideoRender(els.backVideo);
      const okPip = await waitForVideoRender(els.frontVideo);
      if (!okMain || !okPip) {
        backStream.getTracks().forEach(t => t.stop());
        frontStream.getTracks().forEach(t => t.stop());
        throw new Error('Video did not render');
      }

      // Map streams: back -> main, front -> PiP
      els.backVideo.srcObject = backStream;
      els.frontVideo.srcObject = frontStream;

      state.backStream = backStream;
      state.frontStream = frontStream;
      state.dualSupported = true;

      els.switchBtn.disabled = true;
      setStatus('前後カメラを同時に起動しました（前方は右下に表示）。');
      updatePipVisibility();
      return true;
    } catch (e) {
      console.warn('Dual-camera failed; falling back to single', e);
      return false;
    }
  }

  async function startSingle(initialFacing = 'environment') {
    stopStreams();
    state.singleFacing = initialFacing;
    const facing = state.singleFacing;

    const constraints = {
      video: {
        width: { ideal: 720 },
        height: { ideal: 1280 },
        facingMode: facing,
      },
      audio: false,
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      state.singleStream = stream;
      // Show stream in both videos but emphasize the active one
      if (facing === 'user') {
        ensureVideoAttributes(els.frontVideo);
        els.frontVideo.srcObject = stream;
        els.backVideo.srcObject = null;
        await safePlay(els.frontVideo);
        highlightCard('front');
      } else {
        ensureVideoAttributes(els.backVideo);
        els.backVideo.srcObject = stream;
        els.frontVideo.srcObject = null;
        await safePlay(els.backVideo);
        highlightCard('back');
      }
      els.switchBtn.disabled = false;
      state.dualSupported = false;
      updatePipVisibility();
      setStatus(`単一カメラモード: ${facing === 'user' ? '前面' : '背面'}`);
    } catch (e) {
      console.error('startSingle error', e);
      setStatus('カメラの起動に失敗しました。権限を許可し、HTTPS/localhostで開いてください。');
    }
  }

  function highlightCard(which) {
    const cards = Array.from(document.querySelectorAll('.video-card'));
    cards.forEach(c => c.style.outline = 'none');
    const idx = which === 'front' ? 0 : 1;
    cards[idx].style.outline = '2px solid rgba(76, 201, 240, 0.7)';
  }

  function stopStreams() {
    [state.frontStream, state.backStream, state.singleStream].forEach(s => {
      if (!s) return;
      s.getTracks().forEach(t => t.stop());
    });
    state.frontStream = state.backStream = state.singleStream = null;
    els.frontVideo.srcObject = null;
    els.backVideo.srcObject = null;
  }

  async function startCameras() {
    setStatus('カメラを準備中...');
    await requestWakeLock();
    // iOS / Android require user gesture to allow camera; this is called by button.
    const dualOk = await tryStartDual();
    if (!dualOk) {
      // Fallback: show back camera as main. Inform user that同時表示は機種依存で不可の場合があります。
      await startSingle('environment');
      setStatus('端末の制限により同時表示ができないため、背面のみ表示中。必要に応じて「カメラ切替」で前面に切替可能です。');
    }
    els.stopBtn.disabled = false;
  }

  async function switchCamera() {
    if (state.dualSupported) return; // not needed
    const next = state.singleFacing === 'user' ? 'environment' : 'user';
    await startSingle(next);
  }

  function cleanupWakeLock() {
    try { state.wakeLock?.release?.(); } catch {}
    state.wakeLock = null;
  }

  function stopAll() {
    stopStreams();
    els.stopBtn.disabled = true;
    els.switchBtn.disabled = true;
    cleanupWakeLock();
    state.dualSupported = false;
    updatePipVisibility();
    setStatus('停止しました。');
  }

  // ---- Fake Call implementation ----
  function makeRingtone() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain();
    master.gain.value = 0.0;
    master.connect(ctx.destination);

    let step = 0;
    let intervalId = null;

    function playBurst(freq, durationMs, volume = 0.2) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      osc.connect(gain);
      gain.connect(master);
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(volume, now + 0.01);
      gain.gain.setTargetAtTime(0, now + durationMs / 1000 - 0.05, 0.03);
      osc.start(now);
      osc.stop(now + durationMs / 1000);
    }

    function patternTick() {
      // Simple repeating pattern reminiscent of phone ring: two quick beeps, pause
      step = (step + 1) % 6;
      master.gain.value = 1.0;
      if (step === 0 || step === 2) {
        playBurst(800, 250, 0.25);
      }
      if (step === 4) {
        master.gain.value = 0.7;
      }
    }

    return {
      start: async () => {
        await ctx.resume();
        if (intervalId) return;
        patternTick();
        intervalId = setInterval(patternTick, 400);
      },
      stop: () => {
        clearInterval(intervalId);
        intervalId = null;
        master.gain.value = 0;
        // Also suspend to save battery
        ctx.suspend?.();
      },
    };
  }

  function startVibration() {
    if (!('vibrate' in navigator)) return;
    stopVibration();
    // Some browsers ignore long patterns; re-trigger with interval
    navigator.vibrate([0, 300, 200, 300]);
    state.vibrationInterval = setInterval(() => navigator.vibrate([0, 300, 200, 300]), 1500);
  }
  function stopVibration() {
    if (!('vibrate' in navigator)) return;
    try { navigator.vibrate(0); } catch {}
    if (state.vibrationInterval) {
      clearInterval(state.vibrationInterval);
      state.vibrationInterval = null;
    }
  }

  function openIncomingOverlay() {
    els.overlay.classList.remove('hidden');
    els.overlay.setAttribute('aria-hidden', 'false');
  }
  function closeOverlay() {
    els.overlay.classList.add('hidden');
    els.overlay.setAttribute('aria-hidden', 'true');
  }

  async function startFakeCall() {
    // Create on-demand to meet autoplay restrictions
    if (!state.ringtone) state.ringtone = makeRingtone();
    state.ringing = true;
    await state.ringtone.start();
    startVibration();
    openIncomingOverlay();
  }

  function stopFakeCall() {
    state.ringing = false;
    state.ringtone?.stop();
    stopVibration();
    closeOverlay();
  }

  // Button Handlers
  els.startBtn.addEventListener('click', startCameras);
  els.switchBtn.addEventListener('click', switchCamera);
  els.stopBtn.addEventListener('click', stopAll);
  els.fakeCallBtn.addEventListener('click', startFakeCall);

  // Swap main and PiP by tapping the PiP (only in dual mode)
  els.pipWrap?.addEventListener('click', () => {
    if (!state.dualSupported) return;
    const mainIsBack = els.backVideo.srcObject === state.backStream;
    if (mainIsBack) {
      // Put front as main
      els.backVideo.srcObject = state.frontStream;
      els.frontVideo.srcObject = state.backStream;
      setStatus('前方カメラをメイン表示に切替えました。');
    } else {
      // Put back as main
      els.backVideo.srcObject = state.backStream;
      els.frontVideo.srcObject = state.frontStream;
      setStatus('後方カメラをメイン表示に切替えました。');
    }
  });

  els.answerBtn.addEventListener('click', () => {
    // Answering stops ringtone but could keep overlay for a second (simulate connect)
    stopFakeCall();
    setStatus('通話に応答しました (演出)。');
  });
  els.declineBtn.addEventListener('click', () => {
    stopFakeCall();
    setStatus('着信を拒否しました (演出)。');
  });

  // Page visibility: release wake lock when hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cleanupWakeLock();
    } else if (state.frontStream || state.backStream || state.singleStream) {
      requestWakeLock();
    }
  });

  // Hints to user
  setStatus('「カメラ開始」を押して前後を確認。HTTPS/localhostでのアクセスが必要な場合があります。');
})();
