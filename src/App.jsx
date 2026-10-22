import { useRef, useState, useEffect } from "react";
import "./App.css";

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [status, setStatus] = useState("Ready — Tap to speak");
  const [error, setError] = useState("");
  const [latestTip, setLatestTip] = useState(null);
  const [robotMood, setRobotMood] = useState("neutral");
  const [mouthOpen, setMouthOpen] = useState(0);
  const [liveVolume, setLiveVolume] = useState(0);

  // 🧠 PERSISTENT LONG-TERM MEMORY (Survives refreshes & days)
  const [history, setHistory] = useState(() => {
    try {
      const saved = localStorage.getItem("orbit_history");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  const [memoryProfile, setMemoryProfile] = useState(() => {
    try {
      const saved = localStorage.getItem("orbit_memory_profile");
      return saved ? JSON.parse(saved) : { facts: [] };
    } catch {
      return { facts: [] };
    }
  });

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioPlayerRef = useRef(null);
  const chatScrollRef = useRef(null);

  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const animFrameRef = useRef(null);

  const handsFreeRef = useRef(false);
  const micCtxRef = useRef(null);
  const vadIntervalRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const hasSpokenRef = useRef(false);

  const API_URL = "https://ai-voice-robot.onrender.com/chat-voice";

  // Sync state with localStorage
  useEffect(() => {
    try {
      localStorage.setItem("orbit_history", JSON.stringify(history));
    } catch {}
  }, [history]);

  useEffect(() => {
    try {
      localStorage.setItem("orbit_memory_profile", JSON.stringify(memoryProfile));
    } catch {}
  }, [memoryProfile]);

  useEffect(() => {
    handsFreeRef.current = handsFree;
  }, [handsFree]);

  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [history]);

  function setupLipSync() {
    if (audioCtxRef.current || !audioPlayerRef.current) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;

      const source = ctx.createMediaElementSource(audioPlayerRef.current);
      source.connect(analyser);
      analyser.connect(ctx.destination);

      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
    } catch (e) {
      console.log("AudioContext error:", e);
    }
  }

  function startLipSyncAnimation() {
    if (!analyserRef.current) return;
    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);

    function updateMouth() {
      if (!analyserRef.current) return;
      analyserRef.current.getByteFrequencyData(dataArray);

      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;
      setMouthOpen(Math.min(100, Math.round((avg / 128) * 100)));

      animFrameRef.current = requestAnimationFrame(updateMouth);
    }
    updateMouth();
  }

  function stopLipSyncAnimation() {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    setMouthOpen(0);
  }

  async function setupSilenceDetection(stream) {
    if (!handsFreeRef.current) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      const micCtx = new AudioContext();
      await micCtx.resume();

      const source = micCtx.createMediaStreamSource(stream);
      const analyser = micCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      micCtxRef.current = micCtx;

      const dataArray = new Uint8Array(analyser.fftSize);
      hasSpokenRef.current = false;
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);

      vadIntervalRef.current = setInterval(() => {
        if (!mediaRecorderRef.current || mediaRecorderRef.current.state !== "recording") {
          clearInterval(vadIntervalRef.current);
          return;
        }

        analyser.getByteTimeDomainData(dataArray);
        let deviation = 0;
        for (let i = 0; i < dataArray.length; i++) {
          deviation += Math.abs(dataArray[i] - 128);
        }
        const volume = Math.round((deviation / dataArray.length) * 2);
        setLiveVolume(volume);

        if (volume > 6) {
          hasSpokenRef.current = true;
          setStatus("⚡ Speaking detected...");
          if (silenceTimerRef.current) {
            clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = null;
          }
        } else if (hasSpokenRef.current && !silenceTimerRef.current) {
          setStatus("⚡ Paused — Sending in 1s...");
          silenceTimerRef.current = setTimeout(() => {
            clearInterval(vadIntervalRef.current);
            stopRecording();
          }, 1200);
        }
      }, 80);
    } catch (e) {
      console.log("VAD error:", e);
    }
  }

  async function startRecording() {
    try {
      setError("");
      setStatus(handsFreeRef.current ? "⚡ Hands-Free: Speak now!" : "Listening... Speak naturally!");
      setRobotMood("listening");
      audioChunksRef.current = [];
      hasSpokenRef.current = false;

      if (audioCtxRef.current && audioCtxRef.current.state === "suspended") {
        audioCtxRef.current.resume();
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";

      const options = mimeType ? { mimeType } : {};
      const mediaRecorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        if (micCtxRef.current) {
          micCtxRef.current.close();
          micCtxRef.current = null;
        }
        if (vadIntervalRef.current) clearInterval(vadIntervalRef.current);
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        setLiveVolume(0);

        const actualType = mediaRecorder.mimeType || "audio/webm";
        const audioBlob = new Blob(audioChunksRef.current, { type: actualType });
        await sendAudioToBackend(audioBlob, actualType);
      };

      mediaRecorder.start();
      setIsRecording(true);
      setupSilenceDetection(stream);
    } catch (err) {
      console.error(err);
      setError("Microphone permission denied or not available.");
      setStatus("Ready — Tap to speak");
      setRobotMood("neutral");
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      setStatus("Orbit is thinking...");
      setRobotMood("thinking");
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }

  async function sendAudioToBackend(audioBlob, mimeType) {
    try {
      const ext = mimeType.includes("mp4") ? "mp4" : "webm";
      const formData = new FormData();
      formData.append("file", audioBlob, `recording.${ext}`);
      formData.append("history", JSON.stringify(history));
      // Send persistent user profile memory:
      formData.append("memory_profile", JSON.stringify(memoryProfile));

      const response = await fetch(API_URL, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errDetail = await response.text();
        throw new Error(errDetail || "Backend error");
      }

      const data = await response.json();
      setStatus("Orbit is speaking...");
      setRobotMood(data.mood || "happy");
      setLatestTip(data.grammar_tip);

      // Save new facts learned by Orbit
      if (data.updated_profile && Object.keys(data.updated_profile).length > 0) {
        setMemoryProfile(data.updated_profile);
      }

      if (data.user_transcript && data.robot_reply) {
        setHistory((prev) => [
          ...prev,
          { role: "user", content: data.user_transcript },
          {
            role: "assistant",
            content: data.robot_reply,
            translation: data.translation,
            tip: data.grammar_tip,
          },
        ]);
      }

      if (data.audio_base64) {
        setupLipSync();
        const audioSrc = `data:audio/mp3;base64,${data.audio_base64}`;
        if (audioPlayerRef.current) {
          audioPlayerRef.current.src = audioSrc;
          setIsSpeaking(true);
          startLipSyncAnimation();
          audioPlayerRef.current.play();

          audioPlayerRef.current.onended = () => {
            setIsSpeaking(false);
            stopLipSyncAnimation();
            setRobotMood("neutral");

            if (handsFreeRef.current) {
              setStatus("⚡ Your turn — Listening...");
              setTimeout(() => {
                if (handsFreeRef.current) startRecording();
              }, 400);
            } else {
              setStatus("Ready for your next question!");
            }
          };
        }
      }
    } catch (err) {
      console.error(err);
      setError(err.message || "Failed to communicate with Orbit.");
      setStatus("Error occurred — Try again");
      setIsSpeaking(false);
      setRobotMood("neutral");
    }
  }

  function resetFullMemory() {
    setHistory([]);
    setMemoryProfile({ facts: [] });
    localStorage.removeItem("orbit_history");
    localStorage.removeItem("orbit_memory_profile");
    setLatestTip(null);
    setRobotMood("neutral");
    setStatus("All past memory cleared! Orbit has reset.");
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">🤖</div>
          <div>
            <h1>ORBIT</h1>
            <p>HUMANOID AI WITH LIFELONG MEMORY</p>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <button
            onClick={() => {
              const nextVal = !handsFree;
              setHandsFree(nextVal);
              handsFreeRef.current = nextVal;
              if (isRecording) stopRecording();
            }}
            style={{
              background: handsFree ? "#63efb220" : "#ffffff10",
              border: `1px solid ${handsFree ? "#63efb2" : "#ffffff30"}`,
              color: handsFree ? "#63efb2" : "#8190a9",
              padding: "6px 12px",
              borderRadius: "20px",
              fontSize: "11px",
              fontWeight: "600",
              cursor: "pointer",
            }}
          >
            {handsFree ? "⚡ Hands-Free: ON" : "🎙️ Hands-Free: OFF"}
          </button>
          <div className="status">
            <span
              className="status-dot"
              style={{
                background: isRecording || isSpeaking ? "#63efb2" : "#8190a9",
                boxShadow: isRecording || isSpeaking ? "0 0 12px #63efb2" : "none",
              }}
            />
            <span>{isSpeaking ? "TALKING" : isRecording ? "LISTENING" : "READY"}</span>
          </div>
        </div>
      </header>

      <main className="main-content">
        <section className="intro">
          <p className="eyebrow">PERSISTENT MEMORY ACROSS DAYS</p>
          <h2>ORBIT</h2>

          {/* Grammar Tutor Tip Box */}
          {latestTip && (
            <div style={{ background: "#ffd16618", border: "1px solid #ffd16655", padding: "10px 16px", borderRadius: "12px", marginTop: "10px", textAlign: "left" }}>
              <span style={{ fontSize: "11px", color: "#ffd166", fontWeight: "700" }}>💡 TUTOR TIP:</span>
              <p style={{ margin: "4px 0 0", color: "#fff", fontSize: "13px" }}>{latestTip}</p>
            </div>
          )}

          {/* 🧠 Memory Bank Status Pill */}
          <div style={{ marginTop: "12px", textAlign: "left", background: "#63efb210", border: "1px solid #63efb233", padding: "8px 14px", borderRadius: "12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "11.5px", color: "#63efb2" }}>
              🧠 <strong>Memory Bank:</strong> {memoryProfile.name ? `User: ${memoryProfile.name} | ` : ""}
              {memoryProfile.facts && memoryProfile.facts.length > 0 ? `${memoryProfile.facts.length} facts remembered` : "Learning facts about you..."}
            </span>
            <button
              onClick={resetFullMemory}
              style={{ background: "transparent", border: "none", color: "#ff7487", fontSize: "10.5px", cursor: "pointer", textDecoration: "underline" }}
            >
              Forget All
            </button>
          </div>

          {/* Scrollable Conversation Feed */}
          {history.length > 0 && (
            <div
              ref={chatScrollRef}
              style={{
                marginTop: "12px",
                maxHeight: "155px",
                overflowY: "auto",
                textAlign: "left",
                background: "#ffffff08",
                padding: "10px 14px",
                borderRadius: "14px",
                border: "1px solid #75e6ff25",
                display: "flex",
                flexDirection: "column",
                gap: "10px",
              }}
            >
              {history.map((item, idx) => (
                <div key={idx} style={{ fontSize: "12.5px", lineHeight: "1.4" }}>
                  {item.role === "user" ? (
                    <div style={{ color: "#8190a9" }}>
                      <strong>👤 You:</strong> {item.content}
                    </div>
                  ) : (
                    <div>
                      <div style={{ color: "#75e6ff" }}>
                        <strong>🤖 Orbit:</strong> {item.content}
                      </div>
                      {item.translation && item.translation !== item.content && (
                        <div style={{ color: "#98a5bb", fontSize: "11px", fontStyle: "italic", marginTop: "2px" }}>
                          🌐 English: "{item.translation}"
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 🤖 FULL HUMANOID ROBOT BODY */}
        <section className={`robot-stage ${isRecording || isSpeaking ? "listening" : ""}`}>
          <div className={`robot-full-body ${isSpeaking ? "talking" : ""}`}>
            <div className="robot-antenna">
              <span className="antenna-light" />
            </div>

            <div className="robot-head">
              <div className="orbit orbit-one" />
              <div className="orbit orbit-two" />

              <div className="robot-face">
                <div className={`robot-eyes ${robotMood}`}>
                  <span />
                  <span />
                </div>

                <div
                  className="robot-mouth"
                  style={{
                    height: `${8 + Math.round((mouthOpen / 100) * 22)}px`,
                    width: `${36 + Math.round((mouthOpen / 100) * 10)}px`,
                    borderBottom: `${3 + Math.round((mouthOpen / 100) * 3)}px solid #73e7ff`,
                    transition: "height 0.05s ease, width 0.05s ease",
                  }}
                />
              </div>
            </div>

            <div className="robot-neck" />

            <div className="robot-torso-row">
              <div className={`robot-arm left-arm ${isSpeaking ? "active-talk" : ""}`}>
                <div className="shoulder" />
                <div className="arm-limb" />
                <div className="robot-hand" />
              </div>

              <div className="robot-chest">
                <div
                  className="reactor-core"
                  style={{
                    boxShadow: `0 0 ${16 + Math.round((mouthOpen / 100) * 30)}px #6de8ff, inset 0 0 10px #ffffff`,
                    transform: `scale(${1 + (mouthOpen / 100) * 0.24})`,
                  }}
                />
              </div>

              <div className={`robot-arm right-arm ${isSpeaking ? "active-talk" : ""}`}>
                <div className="shoulder" />
                <div className="arm-limb" />
                <div className="robot-hand" />
              </div>
            </div>

            <div className="robot-waist" />

            <div className="robot-legs">
              <div className="leg">
                <div className="leg-shin" />
                <div className="boot">
                  <div className="thruster-flame" />
                </div>
              </div>
              <div className="leg">
                <div className="leg-shin" />
                <div className="boot">
                  <div className="thruster-flame" />
                </div>
              </div>
            </div>

            <div className="robot-shadow" />
          </div>

          <div className="voice-bars">
            {[1, 2, 3, 4, 5, 4, 3, 2, 1].map((val, idx) => (
              <span key={idx} style={{ "--i": val }} />
            ))}
          </div>

          <p className="robot-caption">{status}</p>

          {isRecording && handsFree && (
            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "4px" }}>
              <span style={{ fontSize: "10px", color: "#8190a9" }}>Mic:</span>
              <div style={{ width: "80px", height: "6px", background: "#ffffff15", borderRadius: "4px", overflow: "hidden" }}>
                <div
                  style={{
                    width: `${Math.min(100, liveVolume * 4)}%`,
                    height: "100%",
                    background: liveVolume > 6 ? "#63efb2" : "#8190a9",
                    transition: "width 0.08s ease",
                  }}
                />
              </div>
            </div>
          )}
        </section>

        {/* Call Panel */}
        <div className="call-panel">
          {error && <p style={{ color: "#ff7487", fontSize: "13px", marginBottom: "8px" }}>{error}</p>}
          <p className="call-label">{handsFree ? "⚡ HANDS-FREE ACTIVE (PAUSE TO SEND)" : "VOICE INTERACTION"}</p>

          {!isRecording ? (
            <button className="call-button" onClick={startRecording} disabled={isSpeaking}>
              <span>🎙️</span> {handsFree ? "Start Hands-Free Session" : "Tap to Speak"}
            </button>
          ) : (
            <button className="call-button end-call" onClick={stopRecording}>
              <span>⏹️</span> {handsFree ? "Stop Hands-Free" : "Done Speaking"}
            </button>
          )}

          <p className="hint" style={{ marginTop: "10px" }}>
            {handsFree ? "Speak naturally $\rightarrow$ pause for 1s $\rightarrow$ Orbit talks back!" : "Tap speak $\rightarrow$ ask anything $\rightarrow$ Orbit replies."}
          </p>
        </div>
      </main>

      <audio ref={audioPlayerRef} />

      <footer>
        <span>ORBIT 4.0 LIFELONG COMPANION</span>
        <span>PERMANENT MEMORY BANK + FULL BODY GESTURES</span>
        <span>COST: $0.00</span>
      </footer>
    </div>
  );
}

export default App;
