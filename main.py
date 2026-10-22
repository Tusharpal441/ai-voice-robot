import os
import io
import re
import json
import logging
from typing import Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from groq import Groq
import edge_tts

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("orbit-backend")

app = FastAPI(title="Orbit Voice Robot Backend")

# Allow all origins for Vercel and local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

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

def clean_text_for_tts(text: str) -> str:
    """Removes emojis, markdown, and action asterisks for smooth Edge-TTS speech."""
    if not text:
        return ""
    # Remove action text like *laughs*, *smiles*, (chuckles)
    cleaned = re.sub(r'\*[^*]*\*', '', text)
    cleaned = re.sub(r'\([^)]*\)', '', cleaned)
    # Remove markdown formatting characters
    cleaned = re.sub(r'[#_`~>]', '', cleaned)
    # Remove emojis and high unicode symbols
    cleaned = re.sub(r'[\U00010000-\U0010ffff]', '', cleaned)
    # Normalize whitespace
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned

async def synthesize_speech(text: str, voice: str) -> bytes:
    """Synthesizes speech with robust automatic fallback if the voice fails."""
    # Ensure text is not empty
    tts_text = clean_text_for_tts(text)
    if not tts_text or len(tts_text.strip()) < 2:
        tts_text = "I'm right here with you!"

    # 1. First attempt with requested voice
    try:
        comm = edge_tts.Communicate(tts_text, voice)
        audio_stream = bytearray()
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                audio_stream.extend(chunk["data"])
        if len(audio_stream) > 0:
            return bytes(audio_stream)
    except Exception as e:
        logger.warning(f"Voice {voice} failed: {e}. Retrying with default voice.")

    # 2. Second attempt with default JennyNeural voice
    try:
        comm = edge_tts.Communicate(tts_text, VOICE_MAP["default"])
        audio_stream = bytearray()
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                audio_stream.extend(chunk["data"])
        if len(audio_stream) > 0:
            return bytes(audio_stream)
    except Exception as e:
        logger.error(f"Fallback voice failed: {e}")

    # 3. Emergency friendly fallback phrase
    try:
        emergency = edge_tts.Communicate("I am listening. Go ahead!", VOICE_MAP["default"])
        audio_stream = bytearray()
        async for chunk in emergency.stream():
            if chunk["type"] == "audio":
                audio_stream.extend(chunk["data"])
        if len(audio_stream) > 0:
            return bytes(audio_stream)
    except Exception as e:
        logger.error(f"Emergency TTS failed: {e}")

    raise HTTPException(status_code=500, detail="Unable to generate voice audio.")


@app.get("/")
def health_check():
    return {"status": "ok", "service": "Orbit Voice Backend"}


@app.post("/chat")
async def chat_endpoint(
    audio: Optional[UploadFile] = File(None),
    text: Optional[str] = Form(None),
    history: Optional[str] = Form(None),
    memory_profile: Optional[str] = Form(None),
):
    if not client:
        raise HTTPException(status_code=500, detail="Groq API key not configured on server.")

    user_text = ""

    # 1. Speech-to-Text via Groq Whisper if audio file provided
    if audio is not None:
        try:
            audio_bytes = await audio.read()
            audio_file = io.BytesIO(audio_bytes)
            audio_file.name = "audio.wav"
            transcription = client.audio.transcriptions.create(
                file=audio_file,
                model="whisper-large-v3-turbo",
            )
            user_text = transcription.text.strip()
        except Exception as e:
            logger.error(f"Groq Whisper STT error: {e}")
            raise HTTPException(status_code=500, detail=f"Speech recognition error: {str(e)}")
    elif text:
        user_text = text.strip()

    if not user_text:
        raise HTTPException(status_code=400, detail="No audio or text provided.")

    # 2. Parse past conversation history & memory profile
    past_messages = []
    if history:
        try:
            past_messages = json.loads(history)
            if not isinstance(past_messages, list):
                past_messages = []
        except Exception:
            past_messages = []

    profile_notes = memory_profile if memory_profile else "No previous profile."

    # 3. Build Human-like System Prompt with Persistent Memory
    system_prompt = (
        "You are Orbit, a warm, lively, and genuinely helpful AI companion and robot friend.\n"
        "Guidelines:\n"
        "1. Speak naturally and warmly like a close human friend. Be empathetic, enthusiastic, and curious.\n"
        "2. Keep voice answers concise (1-3 conversational sentences) so the conversation flows seamlessly.\n"
        "3. DO NOT output asterisks for actions like *smiles* or *waves* because you are speaking out loud.\n"
        "4. Remember the user's past details, topics discussed, their name, and preferences.\n"
        "5. Respond in the exact language the user used (English, Hindi, Hinglish, Spanish, French, etc.).\n"
        f"User Memory Profile:\n{profile_notes}\n\n"
        "Reply format: You must respond in valid JSON with these 3 keys:\n"
        "{\n"
        '  "reply": "Your conversational response",\n'
        '  "lang_code": "2-letter language code like en, hi, es, fr, etc.",\n'
        '  "updated_profile": "Updated compact summary of user facts learned (name, goals, interests)"\n'
        "}"
    )

    messages = [{"role": "system", "content": system_prompt}]

    # Append up to last 10 turns of history
    for msg in past_messages[-10:]:
        if isinstance(msg, dict) and "role" in msg and "content" in msg:
            messages.append({"role": msg["role"], "content": msg["content"]})

    messages.append({"role": "user", "content": user_text})

    # 4. Generate LLM Reply
    try:
        completion = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=messages,
            response_format={"type": "json_object"},
            temperature=0.7,
            max_tokens=300,
        )
        raw_output = completion.choices[0].message.content
        data = json.loads(raw_output)
        robot_reply = data.get("reply", "I'm listening! Tell me more.")
        lang_code = data.get("lang_code", "en").lower().strip()[:2]
        updated_profile = data.get("updated_profile", profile_notes)
    except Exception as e:
        logger.error(f"Groq LLM generation error: {e}")
        robot_reply = "I'm right here with you! What's on your mind?"
        lang_code = "en"
        updated_profile = profile_notes

    # 5. Determine TTS Voice
    chosen_voice = VOICE_MAP.get(lang_code, VOICE_MAP["default"])

    # 6. Generate Clean Audio with Fail-Safe Retries
    audio_data = await synthesize_speech(robot_reply, chosen_voice)

    # 7. Return Audio with Metadata Headers
    # Encode JSON headers safely
    meta = {
        "user_text": user_text,
        "robot_reply": robot_reply,
        "lang_code": lang_code,
        "updated_profile": updated_profile,
    }

    return Response(
        content=audio_data,
        media_type="audio/mpeg",
        headers={
            "X-Orbit-Meta": json.dumps(meta, ensure_ascii=True),
            "Access-Control-Expose-Headers": "X-Orbit-Meta",
        },
    )
