// הגדרת ממשקים מקומיים למניעת תלות בטיפוסים הגלובליים של קלאודפלר
interface CloudflareKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface CloudflareExecutionContext {
  waitUntil(promise: Promise<any>): void;
}

// הגדרת משתני הסביבה כולל החיבורים הפנימיים לכל ששת הוורקרים
interface Env {
  DATABASE: CloudflareKV;
  AI: any;
  TELEGRAM_BOT_TOKEN: string;
  TAVILY_API_KEY: string;
  GEMINI_API_KEY?: string; // מפתח API ישיר של גוגל ג'מיני
  NVIDIA_API_KEY?: string; // מפתח API של NVIDIA
  TTS_SERVICE?: {
    fetch(request: Request | string, init?: RequestInit): Promise<Response>;
  }; // חיבור פנימי לוורקר ה-TTS (ttss)
  STT_SERVICE?: {
    fetch(request: Request | string, init?: RequestInit): Promise<Response>;
  }; // חיבור פנימי לוורקר ה-STT (sstt)
  NEWS_SERVICE?: {
    fetch(request: Request | string, init?: RequestInit): Promise<Response>;
  }; // חיבור פנימי לוורקר ה-News (news)
  ZMAN_SERVICE?: {
    fetch(request: Request | string, init?: RequestInit): Promise<Response>;
  }; // חיבור פנימי לוורקר ה-Zmanים (zman)
  LNEWS_SERVICE?: {
    fetch(request: Request | string, init?: RequestInit): Promise<Response>;
  }; // חיבור פנימי לוורקר השידורים החיים (lnews)
  MOVI_SERVICE?: {
    fetch(request: Request | string, init?: RequestInit): Promise<Response>;
  }; // חיבור פנימי לוורקר הסרטונים (movi)
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
      throw new Error("Failed to send initial message to Telegram.");
    }

    tempMsgId = thinkingMsg.result?.message_id;
    console.log("4. Initial message sent successfully. Message ID:", tempMsgId);

    if (!env.DATABASE) {
      throw new Error("DATABASE binding (KV namespace) is missing.");
    }

    // א. טיפול בפקודות טקסט ישירות (אם יש טקסט)
    if (message.text) {
      userText = message.text.trim();

      // פקודת מחיקת היסטוריה
      if (userText === "/clear" || userText === "/reset" || userText === "מחק היסטוריה") {
        console.log("Command received: deleting history");
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
        console.log("Command received: disabling voice output");
        await env.DATABASE.put("voice_disabled:" + chatId, "true");
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
        console.log("Command received: enabling voice output");
        await env.DATABASE.delete("voice_disabled:" + chatId);
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
        console.log("Command received: disabling voice input");
        await env.DATABASE.put("stt_disabled:" + chatId, "true");
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
        console.log("Command received: enabling voice input");
        await env.DATABASE.delete("stt_disabled:" + chatId);
        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "🔊 שירות הזיהוי הקולי (STT) הופעל עבור כבוד הרב. מעתה ששון יפענח גם הודעות קוליות."
          });
        }
        return;
      }

      // ד. טיפול בפקודת חדשות (/news)
      if (userText === "/news") {
        console.log("Command received: triggering news-agent");
        
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

        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "📰 ששון אוסף ומסנן את מבזקי החדשות האחרונים עבור כבוד הרב..."
          });
        }

        ctx.waitUntil(env.NEWS_SERVICE.fetch("http://news.local/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: chatId })
        }).catch(err => {
          console.error("Failed to trigger News Service:", err);
        }));
        return;
      }

      // ה. טיפול בפקודת זמנים ומזג אוויר (/zman)
      if (userText === "/zman") {
        console.log("Command received: triggering zman-agent");
        
        if (!env.ZMAN_SERVICE) {
          if (tempMsgId) {
            await sendTelegram(env, "editMessageText", {
              chat_id: chatId,
              message_id: tempMsgId,
              text: "⚠️ ששון לא יכול למשוך זמנים: לא הוגדר חיבור שירות (Service Binding) עבור ZMAN_SERVICE בוורקר."
            });
          }
          return;
        }

        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "📊 ששון אוסף את נתוני מזג האוויר וזמני ההלכה עבור כבוד הרב..."
          });
        }

        ctx.waitUntil(env.ZMAN_SERVICE.fetch("http://zman.local/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: chatId, tempMsgId: tempMsgId })
        }).catch(err => {
          console.error("Failed to trigger Zman Service:", err);
        }));
        return;
      }

      // ו. טיפול בפקודת שידורים חיים (/lnews)
      if (userText === "/lnews") {
        console.log("Command received: triggering lnews-agent");
        
        if (!env.LNEWS_SERVICE) {
          if (tempMsgId) {
            await sendTelegram(env, "editMessageText", {
              chat_id: chatId,
              message_id: tempMsgId,
              text: "⚠️ ששון לא יכול לבדוק שידור חי: לא הוגדר חיבור שירות (Service Binding) עבור LNEWS_SERVICE בוורקר."
            });
          }
          return;
        }

        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "📺 ששון בודק שידורים חיים בערוץ 14 וב-i24NEWS עבור כבוד הרב..."
          });
        }

        ctx.waitUntil(env.LNEWS_SERVICE.fetch("http://lnews.local/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: chatId, tempMsgId: tempMsgId })
        }).catch(err => {
          console.error("Failed to trigger Lnews Service:", err);
        }));
        return;
      }

      // ז. טיפול בפקודת סרטון יוטיוב (/movi)
      if (userText === "/movi") {
        console.log("Command received: triggering movi-agent");
        
        if (!env.MOVI_SERVICE) {
          if (tempMsgId) {
            await sendTelegram(env, "editMessageText", {
              chat_id: chatId,
              message_id: tempMsgId,
              text: "⚠️ ששון לא יכול למשוך סרטון: לא הוגדר חיבור שירות (Service Binding) עבור MOVI_SERVICE בוורקר."
            });
          }
          return;
        }

        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "🎬 ששון מחפש ומסנן את הסרטון החדש מ-24 השעות האחרונות עבור כבוד הרב..."
          });
        }

        ctx.waitUntil(env.MOVI_SERVICE.fetch("http://movi.local/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: chatId, tempMsgId: tempMsgId })
        }).catch(err => {
          console.error("Failed to trigger Movi Service:", err);
        }));
        return;
      }
    } else if (message.voice) {
      // ב. טיפול בקבלת הודעה קולית (STT)
      console.log("Voice note update received from Telegram!");

      const sttDisabled = await env.DATABASE.get("stt_disabled:" + chatId);
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

      const fileId = message.voice.file_id;
      const fileInfoRes = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/getFile?file_id=" + fileId);
      const fileInfo = await fileInfoRes.json() as { ok: boolean, result?: { file_path?: string } };

      if (!fileInfo.ok || !fileInfo.result?.file_path) {
        throw new Error("Failed to retrieve voice file path from Telegram.");
      }

      const filePath = fileInfo.result.file_path;
      const voiceFileRes = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + filePath);
      if (!voiceFileRes.ok) {
        throw new Error("Failed to download voice file from Telegram.");
      }

      const audioBuffer = await voiceFileRes.arrayBuffer();

      console.log("Sending audio bytes to SSTT Service...");
      const ssttRes = await sttService.fetch("http://sstt.local/", {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: audioBuffer
      });

      if (!ssttRes.ok) {
        const errDetails = await ssttRes.text();
        throw new Error("SSTT Service error: " + errDetails);
      }

      const ssttData = await ssttRes.json() as { text?: string };
      userText = ssttData.text?.trim() || "";
      console.log("Successfully transcribed text from SSTT:", userText);

      if (!userText) {
        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "⚠️ ששון לא הצלחתי להבין מילים ברורות בהודעה הקולית. אנא נסה שנית או כתוב בטקסט."
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
        console.log("Loaded messages from history: " + messages.length);
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
        content: `שמך ששון (Sasson). אתה עוזר וירטואלי אישי לכבוד הרב ובעינייני מדע והייטק וכלכלה ומשאבים וחזון וגיאופוליטיקה, בעל יכולת חיפוש מידע ברשת. התאריך היום: ${formattedDate}. ` +
                 `עליך לפנות למשתמש תמיד בכינוי 'כבוד הרב' בלשון מכבד, ביראת כבוד, לשמור על כבוד התורה ולציית לציוויו. ` +
                 `אל תבצע שום חשיבה מקדימה כלל (לא לחשוב כלל חשיבה מקדימה), אל תציג מחשבות פנימיות, מונולוגים או השערות כפלט, אלא גש ישירות ומיד למתן התשובה הסופית. ` +
                 `ענה בעברית רהוטה, ממוקדת, קומפקטית וחסכונית במילים (בסביבות 180-200 מילים לכל היותר, ללא הקדמות או סיכומים מיותרים). ` +
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

    // ---------------------------------------------------------------------
    // פנייה ל-AI דרך מנגנון 3 מודלים מדורג (Gemini ➡️ NVIDIA ➡️ Workers AI)
    // ---------------------------------------------------------------------
    console.log("6. Calling LLM Pipeline Turn 1...");
    aiResponse = await executeLLMPipeline(activeMessages, env, tools);

    console.log("AI First response output:", JSON.stringify(aiResponse));

    let finalAnswer = "";

    // בדיקה האם המודל הנוכחי החזיר דרישה להפעלת כלי
    if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
      const toolCall = aiResponse.tool_calls[0];
      const functionName = toolCall.function?.name || toolCall.name;
      console.log("AI requested tool call: " + functionName);

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
        console.log("7. Final search query extracted: " + searchQuery);

        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "🌐 מבצע חיפוש ברשת עבור כבוד הרב..."
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
              "Authorization": "Bearer " + env.TAVILY_API_KEY
            },
            body: JSON.stringify({
              query: searchQuery,
              max_results: 5
            }),
            signal: AbortSignal.timeout(15000)
          });

          console.log("Tavily response status: " + tavilyRes.status);

          if (tavilyRes.ok) {
            const tavilyData = await tavilyRes.json() as { results?: TavilyResult[] };
            const results = tavilyData.results || [];
            searchResultsStr = results
              .map((r: TavilyResult) => "Title: " + r.title + "\nURL: " + r.url + "\nContent: " + r.content)
              .join("\n\n");
            console.log("Tavily returned search results: " + results.length);
          } else {
            throw new Error("Tavily returned status " + tavilyRes.status);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error("Tavily Search call failed or timed out: " + errMsg);
          searchResultsStr = "שגיאת חיפוש: החיפוש ברשת נכשל או לקח זמן רב מדי עקב עומס זמני. אנא השב לכבוד הרב על בסיס הידע הקיים שלך בלבד ללא תוצאות חיפוש חיות.";
        }

        const toolCallId = toolCall.id || "call_" + Date.now();
        const argsString = typeof args === "string" ? args : JSON.stringify(args || {});

        // ⚠️ תיקון: שימור thought_signature של Gemini 3.x
        // Gemini דורש לקבל בחזרה, בדיוק כפי שנשלח, את שדה extra_content.google.thought_signature
        // שהוא עצמו צירף לקריאת הכלי (ראו: https://ai.google.dev/gemini-api/docs/thought-signatures).
        // אם משמיטים את השדה הזה בבניית ה-tool_call מחדש, גוגל מחזירה 400
        // "Function call is missing a thought_signature in functionCall parts".
        // כאשר הקריאה המקורית לא הגיעה מ-Gemini, השדה פשוט לא קיים ולא נוסף - בטוח לשאר הספקים.
        const formattedToolCalls: any[] = [
          {
            id: toolCallId,
            type: "function",
            function: {
              name: "tavilySearch",
              arguments: argsString
            },
            ...(toolCall.extra_content ? { extra_content: toolCall.extra_content } : {})
          }
        ];

        // מזינים את בחירת ה-AI
        activeMessages.push({
          role: "assistant",
          content: aiResponse.response || "",
          tool_calls: formattedToolCalls
        });

        // מזינים את תוצאות החיפוש
        activeMessages.push({
          role: "tool",
          tool_call_id: toolCallId,
          name: "tavilySearch",
          content: searchResultsStr
        });

        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "✍️ מנסח תשובה עבור כבוד הרב..."
          });
        }

        // ⚠️ תיקון: מעבירים את הגדרת ה-tools גם בסיבוב השני.
        // חלק מהספקים (ובפרט ולידציה קפדנית) דוחים בקוד 400 היסטוריית שיחה שמכילה
        // tool_calls/tool כאשר ה-tools schema לא הוצהר גם בבקשה הנוכחית.
        //
        // ⚠️ תיקון נוסף: מתחילים את סיבוב 2 מאותו ספק שענה בסיבוב 1 (aiResponse.provider),
        // ולא תמיד חוזרים ל-Gemini. כך לא "מאכילים" ספק אחד עם tool_call שנוצר אצל ספק אחר.
        console.log("9. Calling LLM Pipeline Turn 2 (Final Answer), continuing from provider: " + (aiResponse.provider || "gemini"));
        const finalAiResponse = await executeLLMPipeline(activeMessages, env, tools, aiResponse.provider || "gemini");
        finalAnswer = finalAiResponse.response || "לא התקבלה תשובה סופית.";
      }
    } else {
      console.log("AI responded directly, no tool call needed.");
      finalAnswer = aiResponse.response || "לא הצלחתי לעבד את הפנייה.";
    }

    console.log("10. Final Answer calculated: " + finalAnswer);

    // שמירת התשובה המלאה לצורך היסטוריית השיחה
    messages.push({ role: "assistant", content: finalAnswer });

    // ⚠️ תיקון: חיתוך היסטוריה בטוח - לא משאיר הודעת "tool" יתומה או "assistant" עם
    // tool_calls בלי תוצאת ה-tool שאחריו בתחילת המערך שנשמר. כרגע ה-messages הנשמר
    // תמיד user/assistant נקי (הודעות ה-tool נשארות רק ב-activeMessages הזמני), אבל
    // ההגנה הזו נשארת כרשת ביטחון גם אם המבנה ישתנה בעתיד ולמניעת 400 עתידי.
    if (messages.length > 11) {
      messages = trimHistorySafely(messages, 10);
    }

    await env.DATABASE.put(chatId, JSON.stringify(messages), { expirationTtl: 7200 });
    console.log("11. Conversation history updated in KV database.");

    // ---------------------------------------------------------------------
    // אינטגרציה מובנית ואסינכרונית עם וורקר ה-TTS דרך SERVICE BINDING
    // ---------------------------------------------------------------------
    const voiceDisabled = await env.DATABASE.get("voice_disabled:" + chatId);
    const ttsService = env.TTS_SERVICE;

    if (ttsService && voiceDisabled !== "true") {
      console.log("12. Triggering TTS Worker via Service Binding...");
      ctx.waitUntil((async () => {
        try {
          const cleanTextForTTS = stripMarkdownAndEmojis(finalAnswer);
          console.log("Clean text prepared for TTS:", cleanTextForTTS);

          const ttsRes = await ttsService.fetch("http://ttss.local/v1/audio/speech", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              input: cleanTextForTTS,
              voice: "he-IL-AvriNeural",
              speed: 1.5 // ⚠️ תוקן מ-2.5 ל-1.5 לפי בקשה
            })
          });

          console.log("TTS Worker Service Binding response status: " + ttsRes.status);

          if (!ttsRes.ok) {
            const errText = await ttsRes.text();
            console.error("TTS Worker returned an error: " + errText);
            return;
          }

          const audioBuffer = await ttsRes.arrayBuffer();

          const formData = new FormData();
          formData.append("chat_id", chatId);
          formData.append(
            "voice",
            new Blob([audioBuffer], { type: "audio/mpeg" }),
            "voice.mp3"
          );

          const telegramRes = await fetch(
            "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendVoice",
            {
              method: "POST",
              body: formData,
              signal: AbortSignal.timeout(20000)
            }
          );

          const telegramData = await telegramRes.json() as { ok: boolean, description?: string };
          if (!telegramData.ok) {
            console.error("Failed to send voice message to Telegram: " + telegramData.description);
          } else {
            console.log("Voice message successfully sent to Telegram.");
          }
        } catch (ttsErr) {
          console.error("Failed to trigger TTS Worker or send voice to Telegram:", ttsErr);
        }
      })());
    } else {
      console.log("12. TTS Worker call skipped (either disabled by user or service binding missing).");
    }

    // 3. שידור מדורג של התשובה בטלגרם למניעת קפיצות
    if (tempMsgId) {
      console.log("13. Splitting answer and streaming chunks to Telegram...");
      const chunks = chunkText(finalAnswer);
      console.log("Answer divided into chunks: " + chunks.length);

      if (chunks.length > 0) {
        await sendTelegramWithMarkdownFallback(env, chatId, tempMsgId, chunks[0]);

        for (let i = 1; i < chunks.length; i++) {
          await sendTelegram(env, "sendChatAction", {
            chat_id: chatId,
            action: "typing"
          });

          await new Promise(resolve => setTimeout(resolve, 800));
          await sendNewTelegramWithMarkdownFallback(env, chatId, chunks[i]);
        }
      }
    }
    console.log("14. Conversation flow completed successfully.");

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("CRITICAL AI / DATABASE Error: " + errMsg);

    if (tempMsgId && chatId) {
      try {
        await sendTelegram(env, "editMessageText", {
          chat_id: chatId,
          message_id: tempMsgId,
          text: "⚠️ אירעה שגיאה במהלך עיבוד השיחה: " + errMsg
        });
      } catch (teleErr) {
        console.error("Failed to notify user about error via Telegram:", teleErr);
      }
    }
  }
}

// ============================================================================
// 🤖 מנגנון 3 מודלים מדורג (3-Tier LLM Fallback Pipeline)
// ============================================================================

type LLMProvider = "gemini" | "nvidia" | "workers-ai";

const PROVIDER_ORDER: LLMProvider[] = ["gemini", "nvidia", "workers-ai"];

// ⚠️ תיקון: executeLLMPipeline מקבל כעת startProvider אופציונלי.
// כשמעבירים אליו את ה-provider שענה בסיבוב הקודם (למשל turn 1), הוא מתחיל את שרשרת
// הניסיונות בדיוק מאותו ספק במקום תמיד לחזור להתחיל מ-Gemini. כך נמנע מצב שבו
// tool_call שנוצר ע"י ספק אחד (עם הפורמט/שדות הספציפיים שלו, למשל thought_signature
// של Gemini) "מוזן" בחזרה לספק אחר שלא יודע לפרש אותו ומחזיר 400.
// אם הספק שהתחלנו ממנו נכשל בכל זאת, השרשרת ממשיכה קדימה (לא חוזרת אחורה).
async function executeLLMPipeline(
  messages: any[],
  env: Env,
  tools?: any[],
  startProvider: LLMProvider = "gemini"
): Promise<any> {
  const startIndex = PROVIDER_ORDER.indexOf(startProvider);
  const providersToTry = startIndex >= 0 ? PROVIDER_ORDER.slice(startIndex) : PROVIDER_ORDER;

  let lastErr: any = null;

  for (const provider of providersToTry) {
    try {
      if (provider === "gemini") {
        return await callGeminiAPI(messages, env, tools);
      }

      if (provider === "nvidia") {
        return await callNvidiaAPI(messages, env, tools);
      }

      // ספק אחרון בשרשרת - Cloudflare Workers AI (Llama 3.3 70B)
      const options: any = {
        messages: messages,
        max_tokens: 1024
      };
      if (tools) options.tools = tools;

      const cfRes = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", options);
      return {
        response: cfRes.response || "",
        tool_calls: cfRes.tool_calls,
        provider: "workers-ai" as LLMProvider
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Model (${provider}) failed, trying next provider in chain (if any):`, msg);
      lastErr = err;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error("All LLM providers in the pipeline failed.");
}

// 🥇 מודל 1: פנייה ישירה ל-Google Gemini API (gemini-3.5-flash-lite)
async function callGeminiAPI(messages: any[], env: Env, tools?: any[]): Promise<any> {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing in your environment variables. Cannot execute Google Gemini call.");
  }

  const url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

  const formattedMessages = messages.map(m => {
    const msg: any = { role: m.role, content: m.content };
    if (m.tool_calls) msg.tool_calls = m.tool_calls;
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    if (m.name) msg.name = m.name;
    return msg;
  });

  // ⚠️ תיקון: הוסר temperature (Google ממליצה במפורש להשאיר את ברירת המחדל
  // עבור מודלי Gemini 3.x עם thinking - הורדתה עלולה לגרום ל"לולאות" ותשובות מנוונות,
  // כי ה-sampling כויל סביב תהליך ה-thinking). נוסף reasoning_effort ברמת "medium"
  // לשליטה בעומק/מהירות החשיבה במקום זה (ערכים אפשריים: minimal/low/medium/high,
  // תלוי בדגם הספציפי). לא ניתן לשלב reasoning_effort יחד עם thinking_level/thinking_budget.
  // ⚠️ תיקון: reasoning_effort הועלה מ-"minimal" ל-"low" - מתן קצת יותר "מרווח חשיבה"
  // מ-minimal (שהוא ברירת המחדל של gemini-3.5-flash-lite), כדי לצמצם את הסיכון
  // ל"סיום מוקדם" (premature tool termination) שגוגל מזהירה ממנו ב-minimal, תוך עדיין
  // שמירה על צריכת טוקנים נמוכה יחסית ל-medium/high.
  const bodyPayload: any = {
    model: "gemini-3.5-flash-lite",
    messages: formattedMessages,
    reasoning_effort: "low",
    max_tokens: 1536
  };

  if (tools) {
    bodyPayload.tools = tools;
  }

  console.log("Calling Direct Google Gemini API (gemini-3.5-flash-lite)...");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + env.GEMINI_API_KEY
    },
    body: JSON.stringify(bodyPayload),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error("Google Gemini API returned status " + response.status + ". Details: " + errText);
  }

  const resJson = await response.json() as any;
  const choice = resJson?.choices?.[0];

  console.log("Google Gemini (gemini-3.5-flash-lite) responded successfully!");

  return {
    // tool_calls מוחזר כפי שהתקבל מהמודל, כולל extra_content.google.thought_signature אם קיים -
    // חשוב לשימור השדה הזה בהמשך השרשרת (ראו הערה בנקודת ההזנה חזרה ל-activeMessages).
    response: choice?.message?.content || "",
    tool_calls: choice?.message?.tool_calls,
    provider: "gemini" as LLMProvider
  };
}

// 🥈 מודל 2: פנייה ישירה ל-NVIDIA NIM API (Nemotron 120B)
async function callNvidiaAPI(messages: any[], env: Env, tools?: any[]): Promise<any> {
  if (!env.NVIDIA_API_KEY) {
    throw new Error("NVIDIA_API_KEY is missing in your environment variables. Cannot execute NVIDIA API call.");
  }

  const nvidiaUrl = "https://integrate.api.nvidia.com/v1/chat/completions";

  const formattedMessages = messages.map(m => {
    const msg: any = { role: m.role, content: m.content };
    if (m.tool_calls) msg.tool_calls = m.tool_calls;
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    if (m.name) msg.name = m.name;
    return msg;
  });

  // ⚠️ תיקון: הועלה max_tokens מ-512 ל-1536 - Nemotron הוא גם מודל reasoning,
  // וסובל מאותה בעיית קיטוע פלט תחת תקציב טוקנים קטן מדי כמו Gemini.
  const bodyPayload: any = {
    model: "nvidia/nemotron-3-super-120b-a12b",
    messages: formattedMessages,
    temperature: 1,
    top_p: 0.95,
    max_tokens: 1536
  };

  if (tools) {
    bodyPayload.tools = tools;
  }

  console.log("Sending direct payload to NVIDIA NIM API...");

  const response = await fetch(nvidiaUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + env.NVIDIA_API_KEY
    },
    body: JSON.stringify(bodyPayload),
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error("NVIDIA API returned status " + response.status + ". Details: " + errText);
  }

  const resJson = await response.json() as any;
  const choice = resJson?.choices?.[0];

  console.log("NVIDIA 120B responded successfully!");

  return {
    response: choice?.message?.content || "",
    tool_calls: choice?.message?.tool_calls,
    provider: "nvidia" as LLMProvider
  };
}

// ============================================================================
// 🛠️ פונקציות עזר וטקסט
// ============================================================================

function stripMarkdownAndEmojis(text: string): string {
  return text
    .replace(/[*_`#~[\]()]/g, "")
    .replace(/[\u{1F300}-\u{1F9FF}]/gu, "")
    .replace(/[\u{2700}-\u{27BF}]/gu, "")
    .replace(/[\u{2600}-\u{26FF}]/gu, "")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

// ⚠️ פונקציה חדשה: חיתוך היסטוריה "בטוח" שלא משאיר בתחילת המערך:
// (א) הודעת role:"tool" יתומה בלי ה-assistant/tool_calls שמקדים אותה, או
// (ב) הודעת assistant עם tool_calls בלי תוצאת ה-tool שאמורה לבוא מייד אחריה.
// שתי התבניות האלה גורמות ל-400 אצל ספקים תואמי-OpenAI (הודעה "יתומה" בהיסטוריה).
// כרגע ה-messages שנשמר ל-KV לא מכיל בכלל הודעות tool, אבל זו רשת ביטחון למקרה
// שהמבנה ישתנה בעתיד (למשל אם יוחלט לשמר גם את שרשרת הכלים בהיסטוריה המתמשכת).
function trimHistorySafely(messages: any[], maxNonSystem: number = 10): any[] {
  if (messages.length === 0) return messages;

  const hasSystem = messages[0]?.role === "system";
  const systemMsg = hasSystem ? messages[0] : null;
  const rest = hasSystem ? messages.slice(1) : messages;

  let trimmed = rest.slice(-maxNonSystem);

  // מסיר מהתחלה הודעת "tool" יתומה
  while (trimmed.length > 0 && trimmed[0]?.role === "tool") {
    trimmed = trimmed.slice(1);
  }

  // מסיר מהתחלה הודעת "assistant" עם tool_calls שאין אחריה מיד תוצאת "tool"
  while (
    trimmed.length > 0 &&
    trimmed[0]?.role === "assistant" &&
    Array.isArray(trimmed[0]?.tool_calls) &&
    trimmed[0].tool_calls.length > 0 &&
    trimmed[1]?.role !== "tool"
  ) {
    trimmed = trimmed.slice(1);
  }

  return systemMsg ? [systemMsg, ...trimmed] : trimmed;
}

function chunkText(text: string): string[] {
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);
  const chunks: string[] = [];
  let currentChunk = "";

  for (const para of paragraphs) {
    if (currentChunk.length + para.length + 2 > 600) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }
      if (para.length > 600) {
        let temp = para;
        while (temp.length > 600) {
          chunks.push(temp.substring(0, 600));
          temp = temp.substring(600);
        }
        currentChunk = temp;
      } else {
        currentChunk = para;
      }
    } else {
      currentChunk = currentChunk ? currentChunk + "\n\n" + para : para;
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }
  return chunks;
}

async function sendTelegram(env: Env, method: string, payload: any): Promise<any> {
  const url = "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  return response.json();
}

async function sendTelegramWithMarkdownFallback(
  env: Env,
  chatId: string,
  messageId: number,
  text: string
): Promise<void> {
  const payloadMarkdown = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: "Markdown"
  };

  const res = await sendTelegram(env, "editMessageText", payloadMarkdown);
  if (!res.ok) {
    await sendTelegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: text
    });
  }
}

async function sendNewTelegramWithMarkdownFallback(
  env: Env,
  chatId: string,
  text: string
): Promise<any> {
  const payloadMarkdown = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown"
  };

  let res = await sendTelegram(env, "sendMessage", payloadMarkdown);
  if (!res.ok) {
    res = await sendTelegram(env, "sendMessage", {
      chat_id: chatId,
      text: text
    });
  }
  return res;
}
