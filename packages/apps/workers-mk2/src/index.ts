// הגדרת ממשקים מקומיים למניעת תלות בטיפוסים הגלובליים של קלאודפלר
interface CloudflareKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface CloudflareExecutionContext {
  waitUntil(promise: Promise<any>): void;
}

// הגדרת משתני הסביבה כולל חיבור השירות (Service Binding) של ה-TTS
interface Env {
  DATABASE: CloudflareKV;
  AI: any;
  TELEGRAM_BOT_TOKEN: string;
  TAVILY_API_KEY: string;
  TTS_SERVICE?: {
    fetch(request: Request): Promise<Response>;
  }; // חיבור פנימי ישיר במקום משתנה URL חיצוני
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
    if (!message.text) {
      console.log("Aborting: Message object does not contain text.");
      return;
    }

    chatId = message.chat.id.toString();
    const userText = message.text.trim();
    console.log(`2. Processing text: "${userText}" for Chat ID: ${chatId}`);

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

    // טיפול בפקודת מחיקת היסטוריה
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
                 `ענה בעברית רהוטה, עניינית ומקיפה במעט (בסביבות 200-300 מילים במידת הצורך, הימנע מהארכות סרק ומסיכומים מיותרים). ` +
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

    // פנייה ראשונה ל-AI (Llama 3.3 70B Fast)
    console.log("6. Calling Workers AI (Llama 3.3 70B Fast) - Turn 1...");
    const aiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages: activeMessages,
      tools
    });

    console.log("AI First response output:", JSON.stringify(aiResponse));

    let finalAnswer = "";

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
            signal: AbortSignal.timeout(5000) // הגנת קטיעת זמן בעומס
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
            searchResultsStr = `Tavily API returned status ${tavilyRes.status}`;
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          searchResultsStr = `Search failed: ${errMsg}`;
          console.error("Tavily Search call failed:", errMsg);
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

        console.log("9. Calling Workers AI (Llama 3.3 70B Fast) - Turn 2 (Final Answer)...");
        const finalAiResponse = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
          messages: activeMessages
        });

        finalAnswer = finalAiResponse.response || "לא התקבלה תשובה סופית.";
      }
    } else {
      console.log("AI responded directly, no tool call needed.");
      finalAnswer = aiResponse.response || "לא הצלחתי לעבד את הפנייה.";
    }

    console.log("10. Final Answer calculated:", finalAnswer);

    // שמירת התשובה המלאה לצורך היסטוריית השיחה
    messages.push({ role: "assistant", content: finalAnswer });

    if (messages.length > 11) {
      messages = [messages[0], ...messages.slice(-10)];
    }

    await env.DATABASE.put(chatId, JSON.stringify(messages), { expirationTtl: 7200 });
    console.log("11. Conversation history updated in KV database.");

    // ---------------------------------------------------------------------
    // אינטגרציה מובנית ואסינכרונית עם וורקר ה-TTS דרך SERVICE BINDING
    // ---------------------------------------------------------------------
    const ttsService = env.TTS_SERVICE; // שימוש במשתנה מקומי קבוע לפתרון ה-strict null checks ב-closures
    if (ttsService) {
      console.log("12. Triggering TTS Worker via Service Binding...");
      ctx.waitUntil((async () => {
        try {
          const ttsRes = await ttsService.fetch(new Request("http://ttss.local/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chatId: chatId,
              text: finalAnswer
            })
          }));
          console.log("TTS Worker Service Binding response status:", ttsRes.status);
        } catch (ttsErr) {
          console.error("Failed to trigger TTS Worker via Service Binding:", ttsErr);
        }
      })());
    }

    // 3. שידור מדורג של התשובה בטלגרם למניעת קפיצות
    if (tempMsgId) {
      console.log("13. Splitting answer and streaming chunks to Telegram...");
      const chunks = chunkText(finalAnswer);
      console.log(`Answer divided into ${chunks.length} chunks.`);
      
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
    console.error("CRITICAL AI / DATABASE Error:", errMsg);
    
    if (tempMsgId && chatId) {
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
    res = await sendTelegram(env, "sendMessage", {
      chat_id: chatId,
      text: text
    });
  }
  return res;
}
