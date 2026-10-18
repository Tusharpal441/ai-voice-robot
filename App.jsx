import { useRef, useState } from "react";
import "./App.css";

function App() {
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [status, setStatus] = useState("Ready — Tap button to speak");
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState("");
  const [robotReply, setRobotReply] = useState("");

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioPlayerRef = useRef(null);

  // During local development, use localhost. When deployed to Render, change to your Render URL:
  const API_URL = "http://127.0.0.1:8000/chat-voice";

  async function startRecording() {
    try {
      setError("");
      setStatus("Listening... Speak in any language!");
      audioChunksRef.current = [];

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        await sendAudioToBackend(audioBlob);
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error(err);
      setError("Microphone permission denied or not available.");
      setStatus("Ready — Tap button to speak");
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current && isRecording) {
      setStatus("Orbit is thinking...");
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }

  async function sendAudioToBackend(audioBlob) {
    try {
      const formData = new FormData();
      formData.append("file", audioBlob, "recording.webm");

      const response = await fetch(API_URL, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errDetail = await response.text();
        throw new Error(errDetail || "Backend error");
      }

      const data = await response.json();
      setTranscript(data.user_transcript);
      setRobotReply(data.robot_reply);
      setStatus("Orbit is replying...");

      if (data.audio_base64) {
        const audioSrc = `data:audio/mp3;base64,${data.audio_base64}`;
        if (audioPlayerRef.current) {
          audioPlayerRef.current.src = audioSrc;
          setIsSpeaking(true);
          audioPlayerRef.current.play();

          audioPlayerRef.current.onended = () => {
            setIsSpeaking(false);
            setStatus("Ready — Tap button to speak again");
          };
        }
      }
    } catch (err) {
      console.error(err);
      setError(err.message || "Failed to communicate with Orbit.");
      setStatus("Error occurred — Try again");
      setIsSpeaking(false);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">🤖</div>
          <div>
            <h1>ORBIT</h1>
            <p>100% FREE MULTILINGUAL VOICE ROBOT</p>
          </div>
        </div>
        <div className="status">
          <span
            className="status-dot"
            style={{
              background: isRecording || isSpeaking ? "#63efb2" : "#8190a9",
              boxShadow: isRecording || isSpeaking ? "0 0 12px #63efb2" : "none",
            }}
          />
          <span>{isSpeaking ? "SPEAKING" : isRecording ? "LISTENING" : "STANDBY"}</span>
        </div>
      </header>

      <main className="main-content">
        <section className="intro">
          <p className="eyebrow">GROQ LPU + MICROSOFT NEURAL VOICES</p>
          <h2>ORBIT AI</h2>
          <p className="subtitle">
            Speak to Orbit in any language: <strong>English, Hindi, Spanish, French, Japanese</strong>, etc. Orbit understands and replies naturally.
          </p>

          {(transcript || robotReply) && (
            <div style={{ marginTop: "20px", textAlign: "left", background: "#ffffff0a", padding: "14px 18px", borderRadius: "12px", border: "1px solid #75e6ff33" }}>
              {transcript && (
                <p style={{ margin: "0 0 8px 0", color: "#8190a9", fontSize: "13px" }}>
                  👤 <strong>You:</strong> "{transcript}"
                </p>
              )}
              {robotReply && (
                <p style={{ margin: 0, color: "#75e6ff", fontSize: "14px", fontWeight: "500" }}>
                  🤖 <strong>Orbit:</strong> "{robotReply}"
                </p>
              )}
            </div>
          )}
        </section>

        <section className={`robot ${isRecording || isSpeaking ? "listening" : ""}`}>
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />

          <div className="robot-face">
            <div className="robot-eyes">
              <span />
              <span />
            </div>
            <div className="robot-mouth" />
          </div>

          <div className="voice-bars">
            {[1, 2, 3, 4, 5, 4, 3, 2, 1].map((val, idx) => (
              <span key={idx} style={{ "--i": val }} />
            ))}
          </div>

          <p className="robot-caption">{status}</p>
        </section>

        <div className="call-panel">
          {error && <p style={{ color: "#ff7487", fontSize: "13px", marginBottom: "8px" }}>{error}</p>}
          <p className="call-label">VOICE INTERACTION</p>

          {!isRecording ? (
            <button className="call-button" onClick={startRecording} disabled={isSpeaking}>
              <span>🎙️</span> Tap to Speak
            </button>
          ) : (
            <button className="call-button end-call" onClick={stopRecording}>
              <span>⏹️</span> Done Speaking (Send)
            </button>
          )}

          <p className="hint" style={{ marginTop: "12px" }}>
            Tap button $\rightarrow$ speak freely in any language $\rightarrow$ tap Done to hear Orbit reply!
          </p>
        </div>
      </main>

      <audio ref={audioPlayerRef} />

      <footer>
        <span>ORBIT ROBOTICS FREE EDITION</span>
        <span>WHISPER TURBO + LLAMA 3 + NEURAL TTS</span>
        <span>COST: $0.00</span>
      </footer>
    </div>
  );
}

export default App;