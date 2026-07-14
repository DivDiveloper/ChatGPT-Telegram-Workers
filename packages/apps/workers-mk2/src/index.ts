export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    try {
      const update = await request.json();
      
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

async function handleTelegramUpdate(update, env) {
  const message = update.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id.toString();
  const userText = message.text;

  // 1. שלב בדיקת תקינות הגדרות (מניעת קריסות שקטות)
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN variable");
    return;
  }

  // שליחת הודעה ראשונית למשתמש
  const thinkingMsg = await sendTelegram(env, "sendMessage", {
    chat_id: chatId,
    text: "🔍 מעבד את הפנייה שלך..."
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

    // 2. קריאת היסטוריית השיחה מה-KV (המקושר תחת השם DATABASE)
    const rawHistory = await env.DATABASE.get(chatId);
    let messages = [];

    if (rawHistory) {
      try {
        messages = JSON.parse(rawHistory);
      } catch (e) {
        console.error("Error parsing chat history, starting fresh:", e);
        messages = [];
      }
    }

    // הגדרת מערכת ראשונית אם מדובר בשיחה חדשה
    if (messages.length === 0) {
      messages.push({ 
        role: "system", 
        content: "אתה עוזר וירטואלי חכם בעל יכולת חיפוש מידע ברשת בזמן אמת. ענה למשתמש בשפה שבה הוא פנה אליך (בדגש על עברית). השתמש בתוצאות החיפוש במידת הצורך כדי להשיב תשובות מדויקות ומעודכנות." 
      });
    }

    // הוספת הודעת המשתמש הנוכחית להיסטוריית השיחה
    messages.push({ role: "user", content: userText });

    // הגדרת הכלי החיצוני לחיפוש
    const tools = [
      {
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
    ];

    // יצירת עותק מקומי לעבודה על הפנייה הנוכחית
    let activeMessages = [...messages];

    // 3. פנייה ראשונה ל-AI של Cloudflare
    const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: activeMessages,
      tools
    });

    let finalAnswer = "";

    // 4. בדיקה האם המודל דורש לבצע חיפוש
    if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
      const toolCall = aiResponse.tool_calls[0];

      if (toolCall.name === "tavilySearch") {
        let searchQuery = "";
        if (typeof toolCall.arguments === "string") {
          try {
            searchQuery = JSON.parse(toolCall.arguments).query;
          } catch {
            searchQuery = toolCall.arguments;
          }
        } else if (toolCall.arguments && toolCall.arguments.query) {
          searchQuery = toolCall.arguments.query;
        }

        // גיבוי למקרה שהמודל החזיר שאילתה ריקה לכלי
        searchQuery = searchQuery ? searchQuery.trim() : userText;

        // עדכון סטטוס זמני בטלגרם
        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: `🌐 מבצע חיפוש ברשת עבור: "${searchQuery}"...`
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
            const tavilyData = await tavilyRes.json();
            const results = tavilyData.results || [];
            searchResultsStr = results
              .map(r => `Title: ${r.title}\nURL: ${r.url}\nContent: ${r.content}`)
              .join("\n\n");
          } else {
            searchResultsStr = `Tavily API returned status ${tavilyRes.status}`;
          }
        } catch (err) {
          searchResultsStr = `Search failed: ${err.message}`;
        }

        // הזנת בחירת ה-AI ותוצאות החיפוש לעותק ההודעות הפעיל
        activeMessages.push({
          role: "assistant",
          content: aiResponse.response || "",
          tool_calls: aiResponse.tool_calls
        });

        activeMessages.push({
          role: "tool",
          tool_call_id: toolCall.id || "call_tavily",
          name: "tavilySearch",
          content: searchResultsStr || "לא נמצאו תוצאות חיפוש."
        });

        if (tempMsgId) {
          await sendTelegram(env, "editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: `✍️ מנסח תשובה סופית...`
          });
        }

        // פנייה שנייה ל-AI לקבלת התשובה המבוססת על תוצאות החיפוש
        const finalAiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
          messages: activeMessages
        });

        finalAnswer = finalAiResponse.response || "לא התקבלה תשובה סופית.";
      }
    } else {
      // תשובה ישירה ללא צורך בחיפוש
      finalAnswer = aiResponse.response || "לא הצלחתי לעבד את הפנייה.";
    }

    // 5. מניעת שבירת מגבלת התווים של טלגרם (מקסימום 4096 תווים)
    if (finalAnswer.length > 4000) {
      finalAnswer = finalAnswer.substring(0, 4000) + "\n\n*(התשובה קוצרה עקב מגבלת תווים בטלגרם)*";
    }

    // 6. שמירת התשובה הסופית בלבד בהיסטוריה המרכזית (ללא שלבי הביניים של ה-API)
    messages.push({ role: "assistant", content: finalAnswer });

    // הגבלת אורך ההיסטוריה השמורה כדי למנוע חריגה ממגבלת המודל
    if (messages.length > 11) {
      messages = [messages[0], ...messages.slice(-10)];
    }

    // שמירת ההיסטוריה המעודכנת ב-KV תחת הקישור DATABASE למשך שעתיים (7200 שניות)
    await env.DATABASE.put(chatId, JSON.stringify(messages), { expirationTtl: 7200 });

    // 7. עדכון הודעת הטלגרם עם התשובה הסופית
    if (tempMsgId) {
      await sendTelegramWithMarkdownFallback(env, chatId, tempMsgId, finalAnswer);
    }

  } catch (err) {
    console.error("AI / DATABASE Error:", err);
    
    // מניעת שגיאות לולאה זמניות בעת עדכון הודעת השגיאה בטלגרם
    if (tempMsgId) {
      try {
        await sendTelegram(env, "editMessageText", {
          chat_id: chatId,
          message_id: tempMsgId,
          text: `⚠️ אירעה שגיאה במהלך עיבוד השיחה: ${err.message}`
        });
      } catch (teleErr) {
        console.error("Failed to notify user about error via Telegram:", teleErr);
      }
    }
  }
}

async function sendTelegram(env, method, payload) {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  return response.json();
}

async function sendTelegramWithMarkdownFallback(env, chatId, messageId, text) {
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
