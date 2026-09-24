// 通話UIの共有ロジック（複数リモート対応：A=1名, B=2名）
window.CallUI = (function () {
  let room = null;
  let facing = 'user';
  const LK = () => window.LivekitClient;

  function roleLabel(participant) {
    try {
      const meta = participant.metadata ? JSON.parse(participant.metadata) : {};
      const map = { terminal: '利用者', interpreter: '通訳者', guide: '案内人' };
      return map[meta.role] || participant.identity;
    } catch (_) { return participant.identity; }
  }

  function ensureTile(container, participant) {
    let tile = container.querySelector(`[data-pid="${participant.sid}"]`);
    if (!tile) {
      tile = document.createElement('figure');
      tile.setAttribute('data-pid', participant.sid);
      const v = document.createElement('video');
      v.autoplay = true; v.playsInline = true;
      const cap = document.createElement('figcaption');
      cap.textContent = roleLabel(participant);
      tile.appendChild(v); tile.appendChild(cap);
      container.appendChild(tile);
    }
    return tile.querySelector('video');
  }

  async function connect(url, token, els) {
    room = new (LK().Room)({ adaptiveStream: true, dynacast: true });
    room.on(LK().RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (track.kind === 'video') track.attach(ensureTile(els.remoteContainer, participant));
      else if (track.kind === 'audio') track.attach();
    });
    room.on(LK().RoomEvent.ParticipantDisconnected, (participant) => {
      const t = els.remoteContainer.querySelector(`[data-pid="${participant.sid}"]`);
      if (t) t.remove();
    });
    await room.connect(url, token);
    facing = 'user';
    await room.localParticipant.enableCameraAndMicrophone();
    for (const pub of room.localParticipant.videoTrackPublications.values()) {
      if (pub.track) pub.track.attach(els.localVideo);
    }
    return room;
  }

  async function toggleMic(btn) {
    const on = room.localParticipant.isMicrophoneEnabled;
    await room.localParticipant.setMicrophoneEnabled(!on);
    btn.textContent = on ? 'マイク オン' : 'マイク オフ';
  }
  async function toggleCam(btn, localVideo) {
    const on = room.localParticipant.isCameraEnabled;
    await room.localParticipant.setCameraEnabled(!on);
    btn.textContent = on ? 'カメラ オン' : 'カメラ オフ';
    if (!on) for (const pub of room.localParticipant.videoTrackPublications.values()) if (pub.track) pub.track.attach(localVideo);
  }
  // フロント/リア カメラ切替（モバイル）。公開中のカメラトラックを facingMode を変えて撮り直す。
  async function switchCamera(localVideo) {
    if (!room) return;
    const pub = [...room.localParticipant.videoTrackPublications.values()].find((p) => p.track);
    if (!pub || !pub.track || !pub.track.restartTrack) throw new Error('no camera track');
    const next = facing === 'user' ? 'environment' : 'user';
    try {
      await pub.track.restartTrack({ facingMode: next });
      facing = next;
      if (localVideo) pub.track.attach(localVideo);
    } catch (e) {
      // 失敗時は元のカメラで撮り直す（黒画面回避）
      try { await pub.track.restartTrack({ facingMode: facing }); if (localVideo) pub.track.attach(localVideo); } catch (_) {}
      throw e;
    }
  }
  // 背景処理（ぼかし/画像差し替え）。アセットは自ドメイン(/lkbg)配信。
  const BG_ASSETS = { tasksVisionFileSet: location.origin + '/lkbg/wasm', modelAssetPath: location.origin + '/lkbg/selfie_segmenter.tflite' };
  let bgMode = 'off';
  function bgSupported() { try { return !!(window.LKTP && window.LKTP.supportsBackgroundProcessors && window.LKTP.supportsBackgroundProcessors()); } catch (_) { return false; } }
  function localVideoTrack() { if (!room) return null; const p = [...room.localParticipant.videoTrackPublications.values()].find((x) => x.track); return p ? p.track : null; }
  async function setBackground(mode, imgUrl) {
    const track = localVideoTrack(); if (!track) return;
    const TP = window.LKTP; if (!TP) throw new Error('background library not loaded');
    try { await track.stopProcessor(); } catch (_) {}
    if (mode === 'off') { bgMode = 'off'; return; }
    let proc;
    if (mode === 'blur') proc = TP.BackgroundBlur(12, undefined, undefined, { assetPaths: BG_ASSETS });
    else if (mode === 'image') proc = TP.VirtualBackground(imgUrl, undefined, undefined, { assetPaths: BG_ASSETS });
    else return;
    await track.setProcessor(proc); bgMode = mode;
  }
  function disconnect() { if (room) room.disconnect(); room = null; }

  return { connect, toggleMic, toggleCam, switchCamera, setBackground, bgSupported, disconnect };
})();
