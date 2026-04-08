/**
 * Sender page logic.
 * Works with multi-connection TransferEngine.
 */
(function () {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  const fileInfoEl = document.getElementById('file-info');
  const fileNameEl = document.getElementById('file-name');
  const fileSizeEl = document.getElementById('file-size');
  const btnSend = document.getElementById('btn-send');
  const stepSelect = document.getElementById('step-select');
  const stepShare = document.getElementById('step-share');
  const stepTransfer = document.getElementById('step-transfer');
  const stepComplete = document.getElementById('step-complete');
  const shareUrlInput = document.getElementById('share-url');
  const btnCopy = document.getElementById('btn-copy');
  const statusBadge = document.getElementById('status-badge');
  const statusText = document.getElementById('status-text');

  let selectedFile = null;
  let engine = null;

  // --- File selection ---

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      handleFile(fileInput.files[0]);
    }
  });

  function handleFile(file) {
    selectedFile = file;
    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = formatBytes(file.size);
    fileInfoEl.classList.remove('hidden');
  }

  // --- Create room and share link ---

  btnSend.addEventListener('click', async () => {
    if (!selectedFile) return;

    btnSend.disabled = true;
    btnSend.textContent = 'Creating...';

    try {
      const res = await fetch('/api/room', { method: 'POST' });
      const data = await res.json();
      const roomId = data.roomId;

      const shareUrl = `${window.location.origin}/receive/${roomId}`;
      shareUrlInput.value = shareUrl;

      stepSelect.classList.add('hidden');
      stepShare.classList.remove('hidden');

      // Connect WebSocket as sender
      const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProto}//${location.host}/ws?room=${roomId}&role=sender`;
      const signaling = new SignalingClient(wsUrl);
      await signaling.waitOpen();

      engine = new TransferEngine('sender', signaling);

      // Handle signaling messages
      signaling.on('peer-joined', () => {
        statusBadge.className = 'status status-connected';
        statusText.textContent = 'Receiver connected! Starting transfer...';

        setTimeout(() => {
          stepShare.classList.add('hidden');
          stepTransfer.classList.remove('hidden');

          document.getElementById('t-file-name').textContent = selectedFile.name;
          document.getElementById('t-file-size').textContent = formatBytes(selectedFile.size);

          engine.createOffer(selectedFile);
        }, 800);
      });

      // Answer payloads now include { index, type, sdp }
      signaling.on('answer', (payload) => {
        engine.handleAnswer(payload);
      });

      // ICE payloads now include { index, candidate }
      signaling.on('ice-candidate', (payload) => {
        engine.addIceCandidate(payload);
      });

      signaling.on('peer-disconnected', () => {
        statusBadge.className = 'status status-waiting';
        statusText.textContent = 'Receiver disconnected';
      });

      // Progress and stats
      engine.onProgress = (progress) => {
        document.getElementById('progress-bar').style.width = `${progress * 100}%`;
        document.getElementById('stat-progress').textContent = `${Math.round(progress * 100)}%`;
      };

      engine.onStats = (stats) => {
        document.getElementById('stat-speed').textContent = formatSpeed(stats.speed);
        document.getElementById('stat-transferred').textContent = formatBytes(stats.bytesTransferred);
        document.getElementById('stat-eta').textContent = formatTime(stats.eta);
      };

      engine.onComplete = () => {
        stepTransfer.classList.add('hidden');
        stepComplete.classList.remove('hidden');

        const elapsed = (performance.now() - engine.startTime) / 1000;
        const avgSpeed = selectedFile.size / elapsed;
        document.getElementById('final-speed').textContent = formatSpeed(avgSpeed);
        document.getElementById('final-size').textContent = formatBytes(selectedFile.size);
        document.getElementById('final-time').textContent = formatTime(elapsed);

        document.getElementById('progress-bar').classList.add('complete');
      };

      engine.onError = (err) => {
        console.error('Transfer error:', err);
        statusText.textContent = `Error: ${err.message}`;
        statusBadge.className = 'status status-waiting';
      };

    } catch (err) {
      console.error('Failed to create room:', err);
      btnSend.disabled = false;
      btnSend.textContent = 'Create Link';
    }
  });

  // --- Copy link ---

  btnCopy.addEventListener('click', () => {
    shareUrlInput.select();
    navigator.clipboard.writeText(shareUrlInput.value).then(() => {
      btnCopy.textContent = 'Copied!';
      setTimeout(() => { btnCopy.textContent = 'Copy'; }, 2000);
    });
  });
})();
