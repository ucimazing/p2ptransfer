/**
 * Receiver page logic.
 * ROOM_ID is injected by the template.
 */
(function () {
  const stepInterstitial = document.getElementById('step-interstitial');
  const stepConnecting = document.getElementById('step-connecting');
  const stepTransfer = document.getElementById('step-transfer');
  const stepComplete = document.getElementById('step-complete');
  const countdownEl = document.getElementById('countdown');
  const btnStartDownload = document.getElementById('btn-start-download');

  let engine = null;

  // --- Interstitial countdown ---
  let countdown = 5;
  const timer = setInterval(() => {
    countdown--;
    countdownEl.textContent = countdown;
    if (countdown <= 0) {
      clearInterval(timer);
      countdownEl.textContent = '0';
      btnStartDownload.classList.remove('hidden');
      // Auto-start after countdown
      startReceive();
    }
  }, 1000);

  // Manual start button (backup)
  btnStartDownload.addEventListener('click', () => {
    clearInterval(timer);
    startReceive();
  });

  function startReceive() {
    stepInterstitial.classList.add('hidden');
    stepConnecting.classList.remove('hidden');

    // Connect WebSocket as receiver
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${location.host}/ws?room=${ROOM_ID}&role=receiver`;
    const signaling = new SignalingClient(wsUrl);

    signaling.waitOpen().then(() => {
      engine = new TransferEngine('receiver', signaling);

      // Handle signaling
      signaling.on('offer', (offer) => {
        stepConnecting.classList.add('hidden');
        stepTransfer.classList.remove('hidden');
        engine.handleOffer(offer);
      });

      signaling.on('ice-candidate', (candidate) => {
        engine.addIceCandidate(candidate);
      });

      signaling.on('peer-disconnected', () => {
        console.warn('Sender disconnected');
      });

      // File info
      engine.onFileInfo = (info) => {
        document.getElementById('r-file-name').textContent = info.name;
        document.getElementById('r-file-size').textContent = formatBytes(info.size);
      };

      // Progress
      engine.onProgress = (progress) => {
        document.getElementById('progress-bar').style.width = `${progress * 100}%`;
        document.getElementById('stat-progress').textContent = `${Math.round(progress * 100)}%`;
      };

      engine.onStats = (stats) => {
        document.getElementById('stat-speed').textContent = formatSpeed(stats.speed);
        document.getElementById('stat-received').textContent = formatBytes(stats.bytesTransferred);
        document.getElementById('stat-eta').textContent = formatTime(stats.eta);
      };

      // Complete
      engine.onComplete = (result) => {
        stepTransfer.classList.add('hidden');
        stepComplete.classList.remove('hidden');

        document.getElementById('final-speed').textContent = formatSpeed(result.avgSpeed);
        document.getElementById('final-size').textContent = formatBytes(result.fileSize);
        document.getElementById('final-time').textContent = formatTime(result.elapsed);
      };

      engine.onError = (err) => {
        console.error('Transfer error:', err);
      };
    }).catch((err) => {
      console.error('WebSocket connection failed:', err);
      stepConnecting.innerHTML = `
        <div class="card-title">Connection Failed</div>
        <p style="color: var(--red); padding: 24px 0; text-align: center;">
          Could not connect to sender. The link may have expired or the sender closed their browser.
        </p>
        <div style="text-align: center;">
          <a href="/" class="btn btn-outline">Go Home</a>
        </div>
      `;
    });
  }
})();
