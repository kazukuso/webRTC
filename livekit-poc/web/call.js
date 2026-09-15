// 通話UIの共有ロジック（複数リモート対応：A=1名, B=2名）
window.CallUI = (function () {
  let room = null;
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
  function disconnect() { if (room) room.disconnect(); room = null; }

  return { connect, toggleMic, toggleCam, disconnect };
})();
