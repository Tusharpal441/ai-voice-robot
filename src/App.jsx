import React, { useState, useEffect, useRef } from "react";

// Primary and fallback backend endpoints
const BACKEND_URL = "https://ai-voice-robot.onrender.com/api/chat";
const BACKEND_FALLBACK = "https://ai-voice-robot.onrender.com/chat";

export default function App() {
  const [status, setStatus] = useState("idle"); // idle | listening | processing | speaking | error
  const [errorMessage, setErrorMessage] = useState("");
  const [userText, setUserText] = useState("");
  const [robotReply, setRobotReply] = useState("Hi! I'm Orbit. Tap the mic or enable Hands-Free to talk with me!");
  const [currentLang, setCurrentLang] = useState("en");
  const [memoryProfile, setMemoryProfile] = useState("");
  const [isHandsFree, setIsHandsFree] = useState(true);
  const [tutorMode, setTutorMode] = useState(false);
  const [audioVolume, setAudioVolume] = useState(0); // 0 to 1 for mouth/audio reaction
  const [showMemory, setShowMemory] = useState(false);

  // Audio recording & playback refs
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const micStreamRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const speechDetectedRef = useRef(false);
  const currentAudioRef = useRef(null);
  const animationFrameRef = useRef(null);

  // 1. Load memory profile from localStorage on startup
  useEffect(() => {
    const savedMemory = localStorage.getItem("orbit_memory_profile") || "";
    setMemoryProfile(savedMemory);
  }, []);

  // 2. Audio level monitor for mouth movements and silence detection
  const startAudioAnalyzer = (stream) => {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioContext();
      if (audioCtx.state === "suspended") {
        audioCtx.resume();
      }
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.4;
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      audioContextRef.current = audioCtx;
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const checkVolume = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;
        const normalized = Math.min(avg / 70, 1);
        setAudioVolume(normalized);

        // Hands-Free silence detection
        if (isHandsFree && status === "listening") {
          const SPEECH_THRESHOLD = 14;
          if (avg > SPEECH_THRESHOLD) {
            speechDetectedRef.current = true;
            if (silenceTimerRef.current) {
              clearTimeout(silenceTimerRef.current);
              silenceTimerRef.current = null;
            }
          } else if (speechDetectedRef.current && !silenceTimerRef.current) {
            // Wait 1.3s after speech ends to auto-send
            silenceTimerRef.current = setTimeout(() => {
              if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
                stopRecording();
              }
            }, 1300);
          }
        }

        animationFrameRef.current = requestAnimationFrame(checkVolume);
      };

      checkVolume();
    } catch (e) {
      console.warn("AudioContext setup notice:", e);
    }
  };

  const cleanupAudio = () => {
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close().catch(() => {});
    }
    audioContextRef.current = null;
    analyserRef.current = null;
    setAudioVolume(0);
  };

  // 3. Start Recording
  const startRecording = async () => {
    try {
      setErrorMessage("");
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current = null;
      }
      cleanupAudio();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      // Choose supported audio format
      let mimeType = "audio/webm";
      if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        mimeType = "audio/webm;codecs=opus";
      } else if (MediaRecorder.isTypeSupported("audio/mp4")) {
        mimeType = "audio/mp4";
      }

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      speechDetectedRef.current = false;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        if (audioChunksRef.current.length > 0) {
          sendAudioToBackend(audioBlob);
        }
        if (micStreamRef.current) {
          micStreamRef.current.getTracks().forEach((track) => track.stop());
        }
        cleanupAudio();
      };

      recorder.start(100);
      setStatus("listening");
      startAudioAnalyzer(stream);
    } catch (err) {
      console.error("Mic access error:", err);
      setErrorMessage("Microphone access denied. Please allow microphone permissions.");
      setStatus("error");
    }
  };

  // 4. Stop Recording
  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      setStatus("processing");
    }
  };

  // 5. Send Audio to Backend with Fail-safe Fallback
  const sendAudioToBackend = async (blob) => {
    setStatus("processing");
    const formData = new FormData();
    formData.append("audio", blob, "recording.webm");

    // Pass past conversation history
    const history = localStorage.getItem("orbit_history") || "[]";
    formData.append("history", history);

    // Pass persistent memory notes
    const currentMemory = localStorage.getItem("orbit_memory_profile") || "";
    formData.append("memory_profile", currentMemory);

    if (tutorMode) {
      formData.append("tutor_mode", "true");
    }

    let response = null;

    try {
      // First attempt to /api/chat
      try {
        response = await fetch(BACKEND_URL, { method: "POST", body: formData });
      } catch (err) {
        console.warn("Primary endpoint failed, trying fallback...", err);
      }

      // If 404 or failed, try fallback /chat
      if (!response || !response.ok) {
        response = await fetch(BACKEND_FALLBACK, { method: "POST", body: formData });
      }

      if (!response.ok) {
        let errText = "Failed to get response";
        try {
          const errJson = await response.json();
          errText = errJson.detail || JSON.stringify(errJson);
        } catch {
          errText = `HTTP ${response.status}: ${response.statusText}`;
        }
        throw new Error(errText);
      }

      // Read Metadata from header
      const metaHeader = response.headers.get("X-Orbit-Meta");
      let meta = {};
      if (metaHeader) {
        try {
          meta = JSON.parse(metaHeader);
        } catch (e) {
          console.error("Meta parse error:", e);
        }
      }

      if (meta.user_text) setUserText(meta.user_text);
      if (meta.robot_reply) setRobotReply(meta.robot_reply);
      if (meta.lang_code) setCurrentLang(meta.lang_code);

      // Save updated history
      try {
        const histArray = JSON.parse(history);
        if (meta.user_text) histArray.push({ role: "user", content: meta.user_text });
        if (meta.robot_reply) histArray.push({ role: "assistant", content: meta.robot_reply });
        localStorage.setItem("orbit_history", JSON.stringify(histArray.slice(-12)));
      } catch (e) {
        console.error("History save error:", e);
      }

      // Save updated memory profile
      if (meta.updated_profile) {
        setMemoryProfile(meta.updated_profile);
        localStorage.setItem("orbit_memory_profile", meta.updated_profile);
      }

      // Play audio response with mouth lip-sync
      const audioBlob = await response.blob();
      playRobotSpeech(audioBlob);
    } catch (err) {
      console.error("Backend error:", err);
      setErrorMessage(err.message || "Could not connect to Orbit backend.");
      setStatus("error");
    }
  };

  // 6. Play Robot Speech with Audio-reactive Mouth Lip-Sync
  const playRobotSpeech = (audioBlob) => {
    try {
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      currentAudioRef.current = audio;

      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;

      const source = audioCtx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(audioCtx.destination);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const trackMouth = () => {
        if (!currentAudioRef.current || currentAudioRef.current.paused) {
          setAudioVolume(0);
          return;
        }
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        setAudioVolume(Math.min(avg / 60, 1));
        animationFrameRef.current = requestAnimationFrame(trackMouth);
      };

      audio.onplay = () => {
        setStatus("speaking");
        trackMouth();
      };

      audio.onended = () => {
        setStatus("idle");
        setAudioVolume(0);
        // Automatically listen again if Hands-Free is active
        if (isHandsFree) {
          setTimeout(() => {
            startRecording();
          }, 600);
        }
      };

      audio.onerror = () => {
        setStatus("idle");
        setAudioVolume(0);
      };

      audio.play().catch((e) => {
        console.warn("Autoplay notice:", e);
        setStatus("idle");
      });
    } catch (e) {
      console.error("Audio playback error:", e);
      setStatus("idle");
    }
  };

  const clearMemory = () => {
    localStorage.removeItem("orbit_history");
    localStorage.removeItem("orbit_memory_profile");
    setMemoryProfile("");
    setRobotReply("Memory cleared! What would you like to talk about?");
    setShowMemory(false);
  };

  // Calculate dynamic mouth height (0px when silent, up to 22px when talking)
  const mouthHeight = Math.max(3, Math.round(audioVolume * 22));

  return (
    <div className="orbit-app">
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background: #070913; color: #f0f4fc; overflow-x: hidden; }
        .orbit-app { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: space-between; padding: 20px; background: radial-gradient(circle at 50% 20%, #151a33 0%, #070913 80%); }

        /* Top Header */
        .top-bar { width: 100%; max-width: 500px; display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .logo-box { display: flex; align-items: center; gap: 8px; }
        .logo-dot { width: 10px; height: 10px; border-radius: 50%; background: #00f0ff; box-shadow: 0 0 10px #00f0ff; }
        .logo-text { font-size: 1.2rem; font-weight: 700; letter-spacing: 1px; color: #00f0ff; }
        .pill-btn { background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.15); color: #c0c8e0; padding: 6px 12px; border-radius: 20px; font-size: 0.8rem; cursor: pointer; transition: 0.2s; }
        .pill-btn:hover, .pill-btn.active { background: rgba(0, 240, 255, 0.2); border-color: #00f0ff; color: #fff; }

        /* Robot Stage */
        .robot-stage { width: 100%; max-width: 420px; height: 350px; display: flex; justify-content: center; align-items: center; position: relative; margin: 10px 0; }
        .hover-rig { display: flex; flex-direction: column; align-items: center; animation: hoverAnim 3.5s ease-in-out infinite; }
        @keyframes hoverAnim {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-16px); }
        }

        /* Head & Antenna */
        .head-wrapper { display: flex; flex-direction: column; align-items: center; position: relative; }
        .antenna { width: 4px; height: 16px; background: #5a6585; border-radius: 2px; position: relative; }
        .antenna-bulb { width: 10px; height: 10px; border-radius: 50%; background: #00f0ff; position: absolute; top: -8px; left: -3px; box-shadow: 0 0 10px #00f0ff; animation: pulseGlow 1.8s infinite; }
        @keyframes pulseGlow {
          0%, 100% { transform: scale(0.9); opacity: 0.7; }
          50% { transform: scale(1.3); opacity: 1; filter: drop-shadow(0 0 8px #00f0ff); }
        }

        .head { width: 120px; height: 95px; background: linear-gradient(145deg, #1f2742, #111628); border: 2px solid #3d496e; border-radius: 28px 28px 24px 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; box-shadow: 0 8px 25px rgba(0, 240, 255, 0.15); position: relative; }
        .ears { position: absolute; width: 136px; display: flex; justify-content: space-between; top: 38px; }
        .ear { width: 8px; height: 20px; background: #00f0ff; border-radius: 4px; box-shadow: 0 0 8px #00f0ff; }

        .visor { width: 92px; height: 42px; background: #060a14; border-radius: 14px; border: 1.5px solid #2d3859; display: flex; justify-content: space-around; align-items: center; padding: 0 12px; }
        .eye { width: 18px; height: 18px; border-radius: 50%; background: #00f0ff; box-shadow: 0 0 12px #00f0ff; transition: 0.15s; }
        .eye.blinking { transform: scaleY(0.1); }
        .eye.speaking { animation: eyeBounce 0.4s infinite alternate; }
        @keyframes eyeBounce { from { transform: scale(1); } to { transform: scale(1.15); } }

        /* Reactive Lip-Sync Mouth */
        .mouth-track { width: 44px; height: 26px; display: flex; align-items: center; justify-content: center; margin-top: 4px; }
        .mouth { width: 28px; background: #00f0ff; border-radius: 10px; box-shadow: 0 0 10px #00f0ff; transition: height 0.08s ease-out; }

        /* Neck */
        .neck { width: 26px; height: 10px; background: #2a3350; border-radius: 3px; }

        /* Torso & Core */
        .body-row { display: flex; align-items: center; justify-content: center; gap: 8px; }
        .torso { width: 90px; height: 85px; background: linear-gradient(145deg, #1c223a, #101526); border: 2px solid #3d496e; border-radius: 18px; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; box-shadow: 0 5px 20px rgba(0,0,0,0.5); }
        .core { width: 34px; height: 34px; border-radius: 50%; background: radial-gradient(circle, #00f0ff, #0055ff); box-shadow: 0 0 18px #00f0ff; animation: corePulse 2.2s infinite; }
        @keyframes corePulse {
          0%, 100% { transform: scale(0.92); opacity: 0.8; }
          50% { transform: scale(1.1); opacity: 1; filter: drop-shadow(0 0 14px #00f0ff); }
        }

        /* Arms */
        .arm { width: 14px; height: 65px; background: linear-gradient(to bottom, #2a3350, #171d33); border: 1.5px solid #3d496e; border-radius: 10px; position: relative; transform-origin: top center; }
        .arm.left { animation: armLeftIdle 3s infinite ease-in-out; }
        .arm.right { animation: armRightIdle 3s infinite ease-in-out; }
        .arm.left.speaking { animation: armLeftTalk 0.7s infinite alternate ease-in-out; }
        .arm.right.speaking { animation: armRightTalk 0.7s infinite alternate ease-in-out; }

        @keyframes armLeftIdle { 0%, 100% { transform: rotate(8deg); } 50% { transform: rotate(14deg); } }
        @keyframes armRightIdle { 0%, 100% { transform: rotate(-8deg); } 50% { transform: rotate(-14deg); } }
        @keyframes armLeftTalk { from { transform: rotate(10deg); } to { transform: rotate(32deg) translateY(-4px); } }
        @keyframes armRightTalk { from { transform: rotate(-10deg); } to { transform: rotate(-32deg) translateY(-4px); } }

        /* Legs & Thrusters */
        .legs { display: flex; gap: 20px; margin-top: 3px; }
        .leg { width: 16px; height: 42px; background: #192036; border: 1.5px solid #3d496e; border-radius: 6px; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; }
        .thruster-nozzle { width: 22px; height: 8px; background: #354060; border-radius: 4px; }
        .thruster-flame { width: 12px; height: 24px; background: linear-gradient(to bottom, #00f0ff, transparent); border-radius: 50%; box-shadow: 0 0 12px #00f0ff; animation: flameFlicker 0.25s infinite alternate; }
        @keyframes flameFlicker {
          0% { height: 18px; opacity: 0.7; transform: scaleX(0.85); }
          100% { height: 28px; opacity: 1; transform: scaleX(1.15); filter: drop-shadow(0 0 10px #00f0ff); }
        }

        /* Status & Dialog Area */
        .dialog-card { width: 100%; max-width: 500px; background: rgba(18, 23, 43, 0.75); border: 1px solid rgba(255, 255, 255, 0.1); backdrop-filter: blur(12px); border-radius: 18px; padding: 18px; margin: 10px 0; }
        .status-pill { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; margin-bottom: 10px; }
        .status-idle { background: rgba(255,255,255,0.08); color: #8fa0c9; }
        .status-listening { background: rgba(0, 240, 255, 0.2); color: #00f0ff; border: 1px solid #00f0ff; }
        .status-processing { background: rgba(255, 180, 0, 0.2); color: #ffb400; border: 1px solid #ffb400; }
        .status-speaking { background: rgba(0, 255, 136, 0.2); color: #00ff88; border: 1px solid #00ff88; }
        .status-error { background: rgba(255, 50, 80, 0.2); color: #ff3250; border: 1px solid #ff3250; }

        .speech-bubble { font-size: 1.05rem; line-height: 1.45; color: #e5ecff; min-height: 48px; }
        .user-echo { font-size: 0.85rem; color: #7f8ea8; margin-top: 8px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 8px; }

        /* Controls */
        .controls-row { width: 100%; max-width: 500px; display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 10px; }
        .mic-btn { width: 72px; height: 72px; border-radius: 50%; border: none; background: linear-gradient(135deg, #00f0ff, #0077ff); color: #fff; font-size: 1.8rem; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 25px rgba(0, 240, 255, 0.4); transition: 0.2s; }
        .mic-btn:hover { transform: scale(1.06); box-shadow: 0 0 35px rgba(0, 240, 255, 0.6); }
        .mic-btn.active { background: linear-gradient(135deg, #ff3366, #ff0044); box-shadow: 0 0 35px rgba(255, 50, 80, 0.7); animation: pulseRecord 1.2s infinite; }
        @keyframes pulseRecord { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }

        /* Memory Modal */
        .memory-box { width: 100%; max-width: 500px; background: rgba(14, 18, 33, 0.95); border: 1px solid #00f0ff; border-radius: 14px; padding: 14px; margin-top: 10px; font-size: 0.85rem; }
        .memory-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-weight: 600; color: #00f0ff; }
      `}</style>

      {/* Header Bar */}
      <div className="top-bar">
        <div className="logo-box">
          <div className="logo-dot" />
          <span className="logo-text">ORBIT AI</span>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            className={`pill-btn ${isHandsFree ? "active" : ""}`}
            onClick={() => setIsHandsFree(!isHandsFree)}
          >
            {isHandsFree ? "⚡ Hands-Free ON" : "✋ Push-to-Talk"}
          </button>
          <button
            className={`pill-btn ${tutorMode ? "active" : ""}`}
            onClick={() => setTutorMode(!tutorMode)}
          >
            {tutorMode ? "🎓 Tutor ON" : "🎓 Tutor OFF"}
          </button>
          <button className="pill-btn" onClick={() => setShowMemory(!showMemory)}>
            🧠 Memory
          </button>
        </div>
      </div>

      {/* Memory Drawer */}
      {showMemory && (
        <div className="memory-box">
          <div className="memory-header">
            <span>Orbit's Memory Profile</span>
            <button
              onClick={clearMemory}
              style={{ background: "transparent", border: "none", color: "#ff4466", cursor: "pointer", fontSize: "0.8rem" }}
            >
              Clear Memory
            </button>
          </div>
          <p style={{ color: "#a0aec0", lineHeight: "1.4" }}>
            {memoryProfile || "No long-term memories saved yet. Talk with Orbit to start building a profile!"}
          </p>
        </div>
      )}

      {/* Full Body Robot */}
      <div className="robot-stage">
        <div className="hover-rig">
          {/* Head */}
          <div className="head-wrapper">
            <div className="antenna">
              <div className="antenna-bulb" />
            </div>
            <div className="head">
              <div className="ears">
                <div className="ear" />
                <div className="ear" />
              </div>
              <div className="visor">
                <div className={`eye ${status === "speaking" ? "speaking" : ""}`} />
                <div className={`eye ${status === "speaking" ? "speaking" : ""}`} />
              </div>
              <div className="mouth-track">
                <div className="mouth" style={{ height: `${mouthHeight}px` }} />
              </div>
            </div>
          </div>

          <div className="neck" />

          {/* Torso & Arms */}
          <div className="body-row">
            <div className={`arm left ${status === "speaking" ? "speaking" : ""}`} />
            <div className="torso">
              <div className="core" />
            </div>
            <div className={`arm right ${status === "speaking" ? "speaking" : ""}`} />
          </div>

          {/* Legs & Thrusters */}
          <div className="legs">
            <div className="leg">
              <div className="thruster-nozzle" />
              <div className="thruster-flame" />
            </div>
            <div className="leg">
              <div className="thruster-nozzle" />
              <div className="thruster-flame" />
            </div>
          </div>
        </div>
      </div>

      {/* Dialog Bubble */}
      <div className="dialog-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className={`status-pill status-${status}`}>
            {status === "idle" && "Ready"}
            {status === "listening" && "Listening..."}
            {status === "processing" && "Thinking..."}
            {status === "speaking" && "Speaking..."}
            {status === "error" && "Error"}
          </span>
          <span style={{ fontSize: "0.75rem", color: "#6a7b9e", textTransform: "uppercase" }}>
            Lang: {currentLang}
          </span>
        </div>

        <div className="speech-bubble">
          {status === "error" ? (
            <span style={{ color: "#ff4d6d" }}>{errorMessage}</span>
          ) : (
            robotReply
          )}
        </div>

        {userText && (
          <div className="user-echo">
            <strong>You:</strong> "{userText}"
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="controls-row">
        <button
          className={`mic-btn ${status === "listening" ? "active" : ""}`}
          onClick={() => {
            if (status === "listening") {
              stopRecording();
            } else {
              startRecording();
            }
          }}
          title={status === "listening" ? "Tap to Finish" : "Tap to Speak"}
        >
          {status === "listening" ? "⏹️" : "🎙️"}
        </button>
      </div>
    </div>
  );
}
