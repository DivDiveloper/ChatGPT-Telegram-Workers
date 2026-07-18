// הגדרת ממשקים מקומיים למניעת תלות בטיפוסים הגלובליים של קלאודפלר
interface CloudflareExecutionContext {
  waitUntil(promise: Promise<any>): void;
}

interface Env {
  TELEGRAM_BOT_TOKEN: string; // זקוק רק לטוקן של טלגרם
}

interface TTSRequest {
  chatId: string;
  text: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: CloudflareExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const { chatId, text } = await request.json() as TTSRequest;

      if (!chatId || !text) {
        return new Response("Missing parameters", { status: 400 });
      }

      ctx.waitUntil(processAndSendVoice(chatId, text, env));

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("TTS Worker Fetch Error:", errMsg);
      return new Response("Internal Server Error", { status: 500 });
    }
  }
};

async function processAndSendVoice(chatId: string, text: string, env: Env): Promise<void> {
  try {
    if (!env.TELEGRAM_BOT_TOKEN) {
      console.error("Missing TELEGRAM_BOT_TOKEN in TTS Worker");
      return;
    }

    // 1. שידור מצב "שולח הודעה קולית..." בצ'אט
    await sendTelegramAction(env, chatId, "upload_voice");

    // 2. פירוק הטקסט המלא לחלקים קטנים של עד 150 תווים
    const chunks = splitTextIntoTTSChunks(text, 150);
    console.log(`Text split into ${chunks.length} chunks for TTS processing.`);

    // הגבלת השליחה לעד 10 חלקים (בסביבות 1,500 תווים / כ-2.5 דקות של דיבור רציף)
    const activeChunks = chunks.slice(0, 10);

    // 3. ביצוע פניות מקבילות מהירות לגוגל לקבלת קבצי השמע של כל חלק
    const fetchPromises = activeChunks.map(async (chunk) => {
      // הגדרת המהירות ל-1.8 (מהירות קולחת ומהירה ב-80% מהרגיל)
      const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=he&client=tw-ob&ttsspeed=1.8&q=${encodeURIComponent(chunk)}`;
      const response = await fetch(ttsUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
      });
      if (!response.ok) {
        throw new Error(`Google Translate TTS API returned status ${response.status}`);
      }
      return response.arrayBuffer();
    });

    const buffers = await Promise.all(fetchPromises);
    console.log("All audio chunks retrieved successfully.");

    // 4. שרשור מערכי הבייטס (ArrayBuffers) של כל קבצי ה-MP3 לקובץ אחד רציף
    const totalLength = buffers.reduce((acc, buf) => acc + buf.byteLength, 0);
    const combinedBytes = new Uint8Array(totalLength);
    
    let offset = 0;
    for (const buf of buffers) {
      combinedBytes.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }

    // 5. בניית Multipart Form Data לשליחת הקובץ המשורשר לטלגרם
    const formData = new FormData();
    formData.append("chat_id", chatId);
    
    const audioBlob = new Blob([combinedBytes], { type: "audio/mpeg" });
    formData.append("voice", audioBlob, "sasson_voice.mp3");

    // 6. שליחת ההודעה הקולית הרציפה והמלאה (sendVoice) לטלגרם
    const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendVoice`;
    const res = await fetch(telegramUrl, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(15000) // 15 שניות לקטיעת זמן
    });

    const resJson = await res.json() as { ok: boolean, description?: string };
    if (!resJson.ok) {
      console.error("Telegram sendVoice failed:", resJson.description);
    } else {
      console.log("Combined voice note sent successfully to Telegram chat:", chatId);
    }

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("Error in processAndSendVoice:", errMsg);
  }
}

// פונקציית עזר לחלוקת טקסט לחלקים ללא שבירת מילים באמצע
function splitTextIntoTTSChunks(text: string, maxLength: number): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const word of words) {
    if (currentChunk.length + word.length + 1 > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
      }
      currentChunk = word;
    } else {
      currentChunk = currentChunk ? currentChunk + " " + word : word;
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }
  return chunks;
}

async function sendTelegramAction(env: Env, chatId: string, action: string): Promise<any> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        action: action
      }),
      signal: AbortSignal.timeout(3000)
    });
    return response.json();
  } catch (e) {
    console.error("Failed to send telegram action:", e);
  }
}

function sendChatAction(action: string): string {
  return "sendChatAction";
}
