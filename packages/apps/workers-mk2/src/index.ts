// הגדרת ממשקים מקומיים למניעת תלות בטיפוסים הגלובליים של קלאודפלר
interface CloudflareKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface CloudflareExecutionContext {
  waitUntil(promise: Promise<any>): void;
}

// הגדרת משתני הסביבה כולל החיבורים הפנימיים לשלושת הוורקרים (TTS, STT ו-NEWS)
interface Env {
  DATABASE: CloudflareKV;
  AI: any;
  TELEGRAM_BOT_TOKEN: string;
  TAVILY_API_KEY: string;
  TTS_SERVICE?: {
    fetch(request: Request | string, init?: RequestInit): Promise<Response>;
  }; // חיבור פנימי לוורקר ה-TTS (ttss)
  STT_SERVICE?: {
    fetch(request: Request | string, init?: RequestInit): Promise<Response>;
  }; // חיבור פנימי לוורקר ה-STT (sstt)
  NEWS_SERVICE?: {
    fetch(request: Request | string, init?: RequestInit): Promise<Response>;
  }; // חיבור פנימי חדש לוורקר ה-News (news) [1]
  NVIDIA_API_KEY?: string; // מפתח ה-API של NVIDIA שיוגדר כסיקרט מוצפן
}

interface TelegramUpdate {
  message?: {
    message_id: number;
    chat: {
      id: number;
    };
    text?: string;
    voice?: {
      file_id: string;
    }; // זיהוי הודעה קולית מטלגרם
  };
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: CloudflareExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const update = await request.json() as TelegramUpdate;

      // הרצת עיבוד ההודעה ברקע - העברת ה-ctx כפרמטר
      ctx.waitUntil(handleTelegramUpdate(update, env, ctx));

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      console.error("Error receiving webhook request:", err);
      return new Response("OK", { status: 200 });
    }
  }
};

async function handleTelegramUpdate(update: TelegramUpdate, env: Env, ctx: CloudflareExecutionContext): Promise<void> {
  console.log("1. Received Telegram update payload:", JSON.stringify(update));

  let tempMsgId: number | undefined = undefined;
  let chatId = "";

  try {
    const message = update.message;
    if (!message) {
      console.log("Aborting: Update does not contain a message object.");
      return;
    }

    // בדיקה האם ההודעה מכילה טקסט או הודעה קולית (עבור STT)
    if (!message.text && !message.voice) {
      console.log("Aborting: Message contains neither text nor voice.");
      return;
    }

    chatId = message.chat.id.toString();
    let userText = "";

    // בדיקת תקינות הגדרות בסיסיות
    if (!env.TELEGRAM_BOT_TOKEN) {
      throw new Error("Missing TELEGRAM_BOT_TOKEN environment variable");
    }

    // שליחת הודעה ראשונית מכובדת למשתמש
    console.log("3. Sending initial 'thinking' message to Telegram...");
    const thinkingMsg = await sendTelegram(env, "sendMessage", {
      chat_id: chatId,
      text: "🔍 מעבד את פניית כבוד הרב..."
    });

    if (!thinkingMsg || !thinkingMsg.ok) {
      throw new Error(`Failed to send initial message. Telegram API error: ${thinkingMsg?.description || "Unknown error"}`);
    }

    tempMsgId = thinkingMsg.result?.message_id;
    console.log("4. Initial message sent successfully. Message ID:", tempMsgId);

    if (!env.DATABASE) {
      throw new Error("DATABASE binding (KV namespace) is missing.");
    }

    // א. טיפול בפקודת טקסט ישירות (אם יש טקסט)
    if (message.text) {
      userText = message.text.trim();

      // פקודת מחיקת היסטוריה
      if (userText === "/clear" || userText === "/reset" || userText === "מחק היסטוריה") {
        console.log(`Command received: deleting history for chat ${chatId}`);
        await env.DATABASE.delete(chatId);
        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "🗑️ היסטוריית השיחה נמחקה בהצלחה עבור כבוד הרב. ששון מוכן להתחיל מחדש."
          });
        }
        return;
      }

      // פקודת כיבוי השירות הקולי (/voff) - פלט קול מהבוט
      if (userText === "/voff") {
        console.log(`Command received: disabling voice output for chat ${chatId}`);
        await env.DATABASE.put(`voice_disabled:${chatId}`, "true");
        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "🔇 שירות ההודעות הקוליות (TTS) כובה עבור כבוד הרב. מעתה ששון ישיב בכתב בלבד."
          });
        }
        return;
      }

      // פקודת הפעלת השירות הקולי מחדש (/von) - פלט קול מהבוט
      if (userText === "/von") {
        console.log(`Command received: enabling voice output for chat ${chatId}`);
        await env.DATABASE.delete(`voice_disabled:${chatId}`);
        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "🔊 שירות ההודעות הקוליות (TTS) הופעל עבור כבוד הרב. מעתה ששון ישלח גם הודעה קולית."
          });
        }
        return;
      }

      // פקודת כיבוי זיהוי הודעות קוליות מהמשתמש (/soff) - קלט קול לבוט
      if (userText === "/soff") {
        console.log(`Command received: disabling voice input for chat ${chatId}`);
        await env.DATABASE.put(`stt_disabled:${chatId}`, "true");
        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "🔇 שירות הזיהוי הקולי (STT) כובה עבור כבוד הרב. מעתה ששון יקבל הודעות טקסט בלבד."
          });
        }
        return;
      }

      // פקודת הפעלת זיהוי הודעות קוליות מהמשתמש מחדש (/son) - קלט קול לבוט
      if (userText === "/son") {
        console.log(`Command received: enabling voice input for chat ${chatId}`);
        await env.DATABASE.delete(`stt_disabled:${chatId}`);
        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "🔊 שירות הזיהוי הקולי (STT) הופעל עבור כבוד הרב. מעתה ששון יפענח גם הודעות קוליות."
          });
        }
        return;
      }

      // ד. טיפול בפקודת חדשות (/news) [1]
      if (userText === "/news") {
        console.log(`Command received: triggering news-agent for chat ${chatId}`);
        
        if (!env.NEWS_SERVICE) {
          if (tempMsgId) {
            await sendTelegram(env, "editMessageText", {
              chat_id: chatId,
              message_id: tempMsgId,
              text: "⚠️ ששון לא יכול למשוך חדשות: לא הוגדר חיבור שירות (Service Binding) עבור NEWS_SERVICE בוורקר."
            });
          }
          return;
        }

        // שידור עדכון זמני לטלגרם
        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "📰 ששון אוסף ומסנן את מבזקי החדשות האחרונים עבור כבוד הרב..."
          });
        }

        // קריאה מהירה ואסינכרונית לוורקר ה-News ברקע [1]
        ctx.waitUntil((async () => {
          try {
            await env.NEWS_SERVICE.fetch("http://news.local/", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chatId })
            });
          } catch (err) {
            console.error("Failed to trigger News Service:", err);
          }
        })());
        return;
      }
    } else if (message.voice) {
      // ב. טיפול בקבלת הודעה קולית (STT)
      console.log("Voice note update received from Telegram!");

      // בדיקה האם כבוד הרב כיבה את שירות הזיהוי הקולי
      const sttDisabled = await env.DATABASE.get(`stt_disabled:${chatId}`);
      if (sttDisabled === "true") {
        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "🔇 כבוד הרב שלח הודעה קולית, אך שירות הזיהוי הקולי (STT) כבוי כעת. ניתן להפעילו באמצעות הפקודה /son."
          });
        }
        return;
      }

      const sttService = env.STT_SERVICE;
      if (!sttService) {
        throw new Error("STT_SERVICE binding is missing in Main Worker.");
      }

      // שידור מצב "ששון מאזין..."
      await sendTelegram(env, "sendChatAction", {
        chat_id: chatId,
        action: "record_voice"
      });

      if (tempMsgId) {
        await sendTelegram(env, "editMessageText", {
          chat_id: chatId,
          message_id: tempMsgId,
          text: "📥 שומע ומפענח את הודעת כבוד הרב..."
        });
      }

      // 1. קבלת נתיב קובץ האודיו (file_path) מטלגרם
      const fileId = message.voice.file_id;
      const fileInfoRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
      const fileInfo = await fileInfoRes.json() as { ok: boolean, result?: { file_path?: string } };

      if (!fileInfo.ok || !fileInfo.result?.file_path) {
        throw new Error("Failed to retrieve voice file path from Telegram.");
      }

      // 2. הורדת קובץ האודיו הבינארי (.ogg) משרתי טלגרם לזיכרון הוורקר
      const filePath = fileInfo.result.file_path;
      const voiceFileRes = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
      if (!voiceFileRes.ok) {
        throw new Error("Failed to download voice file from Telegram.");
      }

      const audioBuffer = await voiceFileRes.arrayBuffer();

      // 3. שליחת מערך הבייטס פנימית לוורקר ה-SSTT (Whisper) דרך Service Binding
      console.log("Sending audio bytes to SSTT Service...");
      const ssttRes = await sttService.fetch("http://sstt.local/", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: audioBuffer
      });

      if (!ssttRes.ok) {
        const errDetails = await ssttRes.text();
        throw new Error(`SSTT Service returned status ${ssttRes.status}. Details: ${errDetails}`);
      }

      // 4. קבלת הטקסט המתומלל בעברית
      const ssttData = await ssttRes.json() as { text?: string };
      userText = ssttData.text?.trim() || "";
      console.log("Successfully transcribed text from SSTT:", userText);

      if (!userText) {
        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "⚠️ ששון לא הצליח לשמוע מילים ברורות בהודעה הקולית. אנא נסה שנית או כתוב בטקסט."
          });
        }
        return;
      }
    }

    if (!env.TAVILY_API_KEY) {
      throw new Error("TAVILY_API_KEY is missing in environment variables");
    }

    // קריאת היסטוריית השיחה מה-KV
    console.log("5. Reading chat history from KV...");
    const rawHistory = await env.DATABASE.get(chatId);
    let messages: any[] = [];

    if (rawHistory) {
      try {
        messages = JSON.parse(rawHistory);
        console.log(`Loaded ${messages.length} messages from history.`);
      } catch (e) {
        console.error("Error parsing chat history, starting fresh:", e);
        messages = [];
      }
    }

    // הגדרת מערכת ממוקדת ומקוצרת עם הזרקת תאריך דינמי בעברית
    if (messages.length === 0) {
      const today = new Date();
      const formattedDate = today.toLocaleDateString("he-IL", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "long",
        timeZone: "Asia/Jerusalem"
      });

      messages.push({
        role: "system",
        content: `שמך ששון (Sasson). אתה עוזר וירטואלי אישי לכבוד הרב, בעל יכולת חיפוש מידע ברשת. ` +
                 `התאריך היום: ${formattedDate}. ` +
                 `עליך לפנות למשתמש תמיד בכינוי 'כבוד הרב' בלשון נוכח-מכובד, ביראת כבוד עמוקה, לשמור על כבוד התורה ולציית לציוויו. ` +
                 `ענה בעברית רהוטה, ממוקדת, קומפקטית וחסכונית במילים (בסביבות 100-150 מילים לכל היותר, ללא הקדמות או סיכומים מיותרים). ` +
                 `שאילתות החיפוש עבור הכלי (tavilySearch) חייבות להיכתב באנגלית בלבד (לדוגמה: "israel news today") אלא אם התבקשת אחרת במפורש. נסח את התשובה הסופית בעברית.`
      });
    }

    messages.push({ role: "user", content: userText });

    const tools = [
      {
        type: "function",
        function: {
          name: "tavilySearch",
          description: "Search the web for up-to-date and real-time information on any topic.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The search query to search the web for"
              }
            },
            required: ["query"]
          }
        }
      }
    ];

    let activeMessages = [...messages];
    let aiResponse: any = null;

    // פנייה ראשונה ל-AI (שימוש בנבידיה 120B כמודל הראשי למהירות מירבית ואיכות עברית מעולה) [1.2.7]
    console.log("6. Calling NVIDIA NIM API (Nemotron 120B) - Turn 1...");
    try {
      aiResponse = await callNvidiaAPI(activeMessages, env, tools);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn("NVIDIA NIM API Turn 1 failed, falling back to Workers AI (Llama 3.3 70B):", errMsg);

      // גיבוי ל-Llama 3.3 70B במקרה ונבידיה חווה איטיות או שגיאה
      aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: activeMessages,
        tools,
        max_tokens: 512 // מכסה בטוחה וחסכונית ל-Turn 1 [1]
      });
    }

    console.log("AI First response output:", JSON.stringify(aiResponse));

    let finalAnswer = "";

    // בדיקה האם המודל הנוכחי החזיר דרישה להפעלת כלי
    if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
      const toolCall = aiResponse.tool_calls[0];
      const functionName = toolCall.function?.name || toolCall.name;
      console.log("AI requested tool call:", functionName);

      if (functionName === "tavilySearch") {
        const args = toolCall.function?.arguments || toolCall.arguments;
        let searchQuery = "";

        if (typeof args === "string") {
          try {
            searchQuery = JSON.parse(args).query;
          } catch {
            searchQuery = args;
          }
        } else if (args && args.query) {
          searchQuery = args.query;
        }

        searchQuery = searchQuery ? searchQuery.trim() : userText;
        console.log("7. Final search query extracted:", searchQuery);

        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: `🌐 מבצע חיפוש ברשת עבור כבוד הרב...`
          });
        }

        // ביצוע החיפוש ב-Tavily
        console.log("8. Performing Tavily Search API call...");
        let searchResultsStr = "";
        try {
          const tavilyRes = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${env.TAVILY_API_KEY}`
            },
            body: JSON.stringify({
              query: searchQuery,
              max_results: 5
            }),
            signal: AbortSignal.timeout(15000)
          });

          console.log("Tavily response status:", tavilyRes.status);

          if (tavilyRes.ok) {
            const tavilyData = await tavilyRes.json() as { results?: TavilyResult[] };
            const results = tavilyData.results || [];
            searchResultsStr = results
              .map((r: TavilyResult) => `Title: ${r.title}\nURL: ${r.url}\nContent: ${r.content}`)
              .join("\n\n");
            console.log(`Tavily returned ${results.length} search results.`);
          } else {
            throw new Error(`Tavily returned status ${tavilyRes.status}`);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error("Tavily Search call failed or timed out:", errMsg);
          searchResultsStr = "שגיאת חיפוש: החיפוש ברשת נכשל או לקח זמן רב מדי עקב עומס זמני. אנא השב לכבוד הרב על בסיס הידע הקיים שלך בלבד ללא תוצאות חיפוש חיות.";
        }

        const toolCallId = toolCall.id || `call_${Date.now()}`;
        const argsString = typeof args === "string" ? args : JSON.stringify(args || {});

        const formattedToolCalls = [
          {
            id: toolCallId,
            type: "function",
            function: {
              name: "tavilySearch",
