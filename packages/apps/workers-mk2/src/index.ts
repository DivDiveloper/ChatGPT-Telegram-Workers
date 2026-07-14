// הגדרת ממשקים מקומיים למניעת תלות בטיפוסים הגלובליים של קלאודפלר
interface CloudflareKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface CloudflareExecutionContext {
  waitUntil(promise: Promise<any>): void;
}

// שימוש בממשקים המקומיים בהגדרת משתני הסביבה
interface Env {
  DATABASE: CloudflareKV;
  AI: any;
  TELEGRAM_BOT_TOKEN: string;
  TAVILY_API_KEY: string;
}

// הגדרת המבנה של עדכון מטלגרם
interface TelegramUpdate {
  message?: {
    message_id: number;
    chat: {
      id: number;
    };
    text?: string;
  };
}

// הגדרת תוצאות החיפוש של Tavily
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
      
      // החזרת תשובה מיידית לטלגרם
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
  const userText = message.text;

  // בדיקת תקינות הגדרות בסיסיות
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
    // בדיקת הגדרת ה-KV (DATABASE)
    if (!env.DATABASE) {
      throw new Error("DATABASE binding (KV) is missing. Please define a KV namespace bound as DATABASE in wrangler.toml");
    }

    // בדיקת הגדרת Tavily API Key
    if (!env.TAVILY_API_KEY) {
      throw new Error("TAVILY_API_KEY is missing in your environment variables");
    }

    // קריאת היסטוריית השיחה מה-KV
    const rawHistory = await env.DATABASE.get(chatId);
    let messages: any[] = [];

    if (rawHistory) {
      try {
        messages = JSON.parse(rawHistory);
      } catch (e) {
        console.error("Error parsing chat history, starting fresh:", e);
        messages = [];
      }
    }

    // הגדרת מערכת המגדירה את האישיות של ששון, כבוד הרב, השמירה על כבוד התורה והחסכון בטוקנים
    if (messages.length === 0) {
      messages.push({ 
        role: "system", 
        content: "שמך ששון (Sasson). אתה עוזר וירטואלי אישי וחכם בעל יכולת חיפוש מידע ברשת בזמן אמת. " +
                 "עליך לפנות אל המשתמש תמיד בכינוי 'כבוד הרב' בלשון נוכח-מכובד, ביחס של כבוד והערכה עמוקה ביותר. " +
                 "הישמר מכל משמר חלילה מזילות התורה או פגיעה בכבודה, וציית באופן מלא לציוויו של כבוד הרב. " +
                 "עליך לענות תמיד בצורה מתומצתת במיוחד, קומפקטית וחסכונית ביותר בטוקנים ובמילים. " +
                 "אל תאריך בהקדמות או בסיומים שאינם נחוצים. הבא מיד את השורה התחתונה המדויקת ביותר לשאלה שנשאלה."
      });
    }

    // הוספת הודעת המשתמש הנוכחית להיסטוריית השיחה
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

    // יצירת עותק מקומי לעבודה על הפנייה הנוכחית
    let activeMessages = [...messages];

    // פנייה ראשונה ל-AI של Cloudflare
    const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      messages: activeMessages,
      tools
    });

    let finalAnswer = "";

    // בדיקה האם המודל דורש לבצע חיפוש
    if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
      const toolCall = aiResponse.tool_calls[0];

      // חילוץ שם הפונקציה בצורה בטוחה
      const functionName = toolCall.function?.name || toolCall.name;

      if (functionName === "tavilySearch") {
        // חילוץ הארגומנטים בצורה בטוחה
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

        // גיבוי למקרה שהשאילתה חזרה ריקה
        searchQuery = searchQuery ? searchQuery.trim() : userText;

        // עדכון סטטוס זמני בטלגרם בלשון מכובדת
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

        // בניית מזהה ייחודי עבור ה-tool call ושרשור הארגומנטים כטקסט כפי שמצפה מערכת הוולידציה
        const toolCallId = toolCall.id || `call_${Date.now()}`;
        const argsString = typeof args === "string" ? args : JSON.stringify(args || {});

        // בנייה מחדש של מערך ה-tool_calls בפורמט הסטנדרטי של OpenAI על מנת שיעבור וולידציה
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

        // הזנת בחירת ה-AI (בפורמט המלא) ותוצאות החיפוש לעותק ההודעות הפעיל
        activeMessages.push({
          role: "assistant",
          content: aiResponse.response || "",
          tool_calls: formattedToolCalls
        });

        activeMessages.push({
          role: "tool",
          tool_call_id: toolCallId, // חייב להיות זהה ל-id של ה-tool_call לעיל
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

        // פנייה שנייה ל-AI לקבלת התשובה המבוססת על תוצאות החיפוש
        const finalAiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
          messages: activeMessages
        });

        finalAnswer = finalAiResponse.response || "לא התקבלה תשובה סופית.";
      }
    } else {
      // תשובה ישירה ללא צורך בחיפוש
      finalAnswer = aiResponse.response || "לא הצלחתי לעבד את הפנייה.";
    }

    // מניעת שבירת מגבלת התווים של טלגרם (מקסימום 4096 תווים)
    if (finalAnswer.length > 4000) {
      finalAnswer = finalAnswer.substring(0, 4000) + "\n\n*(התשובה קוצרה עקב מגבלת תווים בטלגרם)*";
    }

    // שמירת התשובה הסופית בלבד בהיסטוריה המרכזית (ללא שלבי הביניים של ה-API)
    messages.push({ role: "assistant", content: finalAnswer });

    // הגבלת אורך ההיסטוריה השמורה כדי למנוע חריגה ממגבלת המודל
    if (messages.length > 11) {
      messages = [messages[0], ...messages.slice(-10)];
    }

    // שמירת ההיסטוריה המעודכנת ב-KV למשך שעתיים (7200 שניות)
    await env.DATABASE.put(chatId, JSON.stringify(messages), { expirationTtl: 7200 });

    // עדכון הודעת הטלגרם עם התשובה הסופית
    if (tempMsgId) {
      await sendTelegramWithMarkdownFallback(env, chatId, tempMsgId, finalAnswer);
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
    // שליחה חוזרת ללא parse_mode במידה ועיצוב ה-Markdown של ה-AI אינו תקין עבור טלגרם
    await sendTelegram(env, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: text
    });
  }
}
