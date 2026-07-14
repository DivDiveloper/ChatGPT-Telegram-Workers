// הגדרת ממשקים מקומיים למניעת תלות בטיפוסים הגלובליים של קלאודפלר
interface CloudflareKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>; // פונקציית מחיקה מה-database
}

interface CloudflareExecutionContext {
  waitUntil(promise: Promise<any>): void;
}

interface Env {
  DATABASE: CloudflareKV;
  AI: any;
  TELEGRAM_BOT_TOKEN: string;
  TAVILY_API_KEY: string;
}

interface TelegramUpdate {
  message?: {
    message_id: number;
    chat: {
      id: number;
    };
    text?: string;
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
      
      // הרצת עיבוד ההודעה ברקע
      ctx.waitUntil(handleTelegramUpdate(update, env));
      
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      console.error("Error receiving webhook:", err);
      return new Response("OK", { status: 200 });
    }
  }
};

async function handleTelegramUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const message = update.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id.toString();
  const userText = message.text.trim();

  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN variable");
    return;
  }

  // שליחת הודעה ראשונית מכובדת למשתמש
  const thinkingMsg = await sendTelegram(env, "sendMessage", {
    chat_id: chatId,
    text: "🔍 מעבד את פניית כבוד הרב..."
  });
  const tempMsgId = thinkingMsg?.result?.message_id;

  try {
    if (!env.DATABASE) {
      throw new Error("DATABASE binding (KV) is missing.");
    }

    // טיפול בפקודת מחיקת היסטוריה
    if (userText === "/clear" || userText === "/reset" || userText === "מחק היסטוריה") {
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

    if (!env.TAVILY_API_KEY) {
      throw new Error("TAVILY_API_KEY is missing");
    }

    // קריאת היסטוריית השיחה מה-KV
    const rawHistory = await env.DATABASE.get(chatId);
    let messages: any[] = [];

    if (rawHistory) {
      try {
        messages = JSON.parse(rawHistory);
      } catch (e) {
        console.error("Error parsing chat history:", e);
        messages = [];
      }
    }

    // הגדרת מערכת והזרקת תאריך דינמי בעברית (לפי שעון ירושלים)
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
        content: `שמך ששון (Sasson). אתה עוזר וירטואלי אישי וחכם בעל יכולת חיפוש מידע ברשת בזמן אמת. ` +
                 `התאריך של היום הוא: ${formattedDate}. ` +
                 `עליך לפנות אל המשתמש תמיד בכינוי 'כבוד הרב' בלשון נוכח-מכובד, ביחס של כבוד והערכה עמוקה ביותר. ` +
                 `הישמר מכל משמר חלילה מזילות התורה או פגיעה בכבודה, וציית באופן מלא לציוויו של כבוד הרב. ` +
                 `עליך לענות תמיד בצורה מתומצתת במיוחד, קומפקטית וחסכונית ביותר בטוקנים ובמילים. ` +
                 `אל תאריך בהקדמות או בסיומים שאינם נחוצים. הבא מיד את השורה התחתונה המדויקת ביותר לשאלה שנשאלה. ` +
                 `כל שאילתות החיפוש שאתה מייצר עבור הכלי (tavilySearch) חייבות להיכתב בשפה האנגלית בלבד (לדוגמה: "who is the prime minister of israel") אלא אם כן כבוד הרב ביקש ממך במפורש לחפש בשפה אחרת. החיפוש באנגלית יניב תוצאות טובות יותר, אך את התשובה לכבוד הרב תנסח תמיד בעברית רהוטה ומכובדת.`
      });
    }

    messages.push({ role: "user", content: userText });

    // הגדרת הכלי החיצוני לחיפוש
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

    // פנייה ראשונה ל-AI (שימוש במודל Llama 3.3 70B Fast)
    const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: activeMessages,
      tools
    });

    let finalAnswer = "";

    if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
      const toolCall = aiResponse.tool_calls[0];
      const functionName = toolCall.function?.name || toolCall.name;

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

        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: `🌐 מבצע חיפוש ברשת עבור כבוד הרב...`
          });
        }

        // ביצוע החיפוש ב-Tavily
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
            })
          });

          if (tavilyRes.ok) {
            const tavilyData = await tavilyRes.json() as { results?: TavilyResult[] };
            const results = tavilyData.results || [];
            searchResultsStr = results
              .map((r: TavilyResult) => `Title: ${r.title}\nURL: ${r.url}\nContent: ${r.content}`)
              .join("\n\n");
          } else {
            searchResultsStr = `Tavily API returned status ${tavilyRes.status}`;
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          searchResultsStr = `Search failed: ${errMsg}`;
        }

        const toolCallId = toolCall.id || `call_${Date.now()}`;
        const argsString = typeof args === "string" ? args : JSON.stringify(args || {});

        const formattedToolCalls = [
          {
            id: toolCallId,
            type: "function",
            function: {
              name: "tavilySearch",
              arguments: argsString
            }
          }
        ];

        activeMessages.push({
          role: "assistant",
          content: aiResponse.response || "",
          tool_calls: formattedToolCalls
        });

        activeMessages.push({
          role: "tool",
          tool_call_id: toolCallId,
          name: "tavilySearch",
          content: searchResultsStr || "לא נמצאו תוצאות חיפוש."
        });

        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: `✍️ מנסח תשובה עבור כבוד הרב...`
          });
        }

        const finalAiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
          messages: activeMessages
        });

        finalAnswer = finalAiResponse.response || "לא התקבלה תשובה סופית.";
      }
    } else {
      finalAnswer = aiResponse.response || "לא הצלחתי לעבד את הפנייה.";
    }

    // שמירת התשובה הסופית המלאה ב-database לצורך היסטוריית השיחה
    messages.push({ role: "assistant", content: finalAnswer });

    if (messages.length > 11) {
      messages = [messages[0], ...messages.slice(-10)];
    }

    await env.DATABASE.put(chatId, JSON.stringify(messages), { expirationTtl: 7200 });

    // 3. שידור מדורג של התשובה למניעת קפיצות בחלון הצ'אט
    if (tempMsgId) {
      const chunks = chunkText(finalAnswer);
      
      if (chunks.length > 0) {
        // עדכון ההודעה הזמנית הראשונה עם הפסקה הראשונה
        await sendTelegramWithMarkdownFallback(env, chatId, tempMsgId, chunks[0]);
        
        // שליחת שאר הפסקאות כהודעות עוקבות חדשות עם דיליי קל המדמה הקלדה
        for (let i = 1; i < chunks.length; i++) {
          await sendTelegram(env, "sendChatAction", {
            chat_id: chatId,
            action: "typing"
          });
          
          // השהייה קלה של 800 מילישניות כדי להעניק חווית קריאה נוחה
          await new Promise(resolve => setTimeout(resolve, 800));
          
          await sendNewTelegramWithMarkdownFallback(env, chatId, chunks[i]);
        }
      }
    }

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("AI / DATABASE Error:", errMsg);
    
    if (tempMsgId) {
      try {
        await sendTelegram(env, "editMessageText", {
          chat_id: chatId,
          message_id: tempMsgId,
          text: `⚠️ אירעה שגיאה במהלך עיבוד השיחה: ${errMsg}`
        });
      } catch (teleErr) {
        console.error("Failed to notify user about error via Telegram:", teleErr);
      }
    }
  }
}

// פונקציה חכמה לחלוקת טקסט ארוך לפסקאות נוחות לקריאה (עד 600 תווים לפסקה)
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
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
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
    // שליחה ללא parse_mode במידה והעיצוב נכשל
    res = await sendTelegram(env, "sendMessage", {
      chat_id: chatId,
      text: text
    });
  }
  return res;
}
