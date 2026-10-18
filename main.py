import base64
import json
import os
import edge_tts
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from groq import Groq

load_dotenv()

app = FastAPI(title="Ultra-Fast Free AI Voice Robot")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

VOICE_MAP = {
    "en": "en-US-JennyNeural",
    "hi": "hi-IN-SwaraNeural",
    "es": "es-ES-ElviraNeural",
    "fr": "fr-FR-DeniseNeural",
    "de": "de-DE-KatjaNeural",
    "ja": "ja-JP-NanamiNeural",
    "zh": "zh-CN-XiaoxiaoNeural",
    "ar": "ar-SA-ZariyahNeural",
    "ru": "ru-RU-SvetlanaNeural",
    "pt": "pt-BR-FranciscaNeural",
    "it": "it-IT-ElsaNeural",
    "ko": "ko-KR-SunHiNeural",
    "default": "en-US-JennyNeural",
}

CACHED_MODEL = None

def get_active_groq_model():
    global CACHED_MODEL
    if CACHED_MODEL:
        return CACHED_MODEL
    try:
        models = [
            m.id for m in groq_client.models.list().data
            if not any(bad in m.id.lower() for bad in ["guard", "embed", "whisper", "moderation", "classify"])
        ]
        print("🤖 Available Generative Chat Models:", models)
        for keyword in ["llama", "gemma", "qwen", "mixtral", "deepseek"]:
            for m in models:
                if keyword in m.lower():
                    CACHED_MODEL = m
                    return m
        CACHED_MODEL = models[0]
        return CACHED_MODEL
    except Exception as e:
        print("Error detecting model:", str(e))
        return "gemma2-9b-it"


@app.get("/")
def home():
    model = get_active_groq_model() if groq_client else "none"
    return {"status": "online", "active_model": model}


@app.post("/chat-voice")
async def chat_voice(file: UploadFile = File(...)):
    if not groq_client:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY missing from backend/.env")

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Empty audio file")

    try:
        # 1. Transcribe user voice using Whisper (~150ms)
        transcription = groq_client.audio.transcriptions.create(
            file=("recording.webm", audio_bytes),
            model="whisper-large-v3-turbo",
            response_format="json",
        )
        user_transcript = transcription.text.strip()

        if not user_transcript:
            return {
                "user_transcript": "",
                "robot_reply": "I didn't hear anything, please speak again.",
                "lang_code": "en",
                "audio_base64": "",
            }

        # 2. Generate intelligent multilingual reply (~150ms)
        chat_model = get_active_groq_model()

        system_prompt = (
            "You are Orbit, an intelligent, cheerful multilingual voice robot. "
            "Detect the language of the user's message. "
            "Reply in the EXACT SAME LANGUAGE that the user spoke (Hindi, English, Spanish, French, etc.). "
            "Keep your reply to 1 single short sentence (max 15 words) so voice chat is snappy. "
            "Output JSON with two keys: 'reply' and 'lang_code' (2-letter code like 'en', 'hi', 'es')."
        )

        completion = groq_client.chat.completions.create(
            model=chat_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_transcript},
            ],
            response_format={"type": "json_object"},
            temperature=0.6,
            max_tokens=80,
        )

        res_json = json.loads(completion.choices[0].message.content)
        robot_reply = res_json.get("reply", "Hello!")
        lang_code = res_json.get("lang_code", "en").lower().strip()

    except Exception as e:
        print("Groq Error:", str(e))
        raise HTTPException(status_code=502, detail=f"Groq error: {str(e)}")

    voice_name = VOICE_MAP.get(lang_code, VOICE_MAP["default"])

    try:
        # 3. Generate natural neural speech audio (~200ms)
        communicate = edge_tts.Communicate(robot_reply, voice_name, rate="+15%")
        tts_audio = b""
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                tts_audio += chunk["data"]

        audio_base64 = base64.b64encode(tts_audio).decode("utf-8")

        return {
            "user_transcript": user_transcript,
            "robot_reply": robot_reply,
            "lang_code": lang_code,
            "audio_base64": audio_base64,
        }

    except Exception as e:
        print("TTS Error:", str(e))
        raise HTTPException(status_code=500, detail=f"TTS error: {str(e)}")