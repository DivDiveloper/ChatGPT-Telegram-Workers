import { DurableObject } from "cloudflare:workers";
import { Env, TelegramUpdate, TavilyResult, LLMProvider } from "./types";
import { TelegramClient } from "./telegram";

const PROVIDER_ORDER: LLMProvider[] = ["gemini", "nvidia", "workers-ai"];

export class ChatSessionDO extends DurableObject<Env> {
  private telegram: TelegramClient;
  private queue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
  }

  /**
   * Main RPC entrypoint called by the thin Worker router.
   * Concurrency is handled by chaining tasks into an in-memory queue per chat session.
   */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    this.queue = this.queue
      .then(() => this.processUpdate(update))
      .catch((err) => {
        console.error("Unhandled error inside ChatSessionDO queue:", err);
      });
    return this.queue;
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    console.log("1. DO received update:", JSON.stringify(update));
    let tempMsgId: number | undefined = undefined;
    let chatId = "";

    try {
      const message = update.message;
      if (!message || (!message.text && !message.voice)) {
        console.log("Aborting: Message contains neither text nor voice.");
        return;
      }

      chatId = message.chat.id.toString();
      let userText = "";

      // 1. Initial "Thinking" message
      console.log("3. Sending initial 'thinking' message...");
      const thinkingMsg = await this.telegram.send("sendMessage", {
        chat_id: chatId,
        text: "🔍 מעבד את פניית כבוד הרב..."
      });

      if (!thinkingMsg || !thinkingMsg.ok) {
        throw new Error("Failed to send initial message to Telegram.");
      }

      tempMsgId = thinkingMsg.result?.message_id;
      console.log("4. Initial message sent successfully. ID:", tempMsgId);

      // 2. Handle Text Commands
      if (message.text) {
        userText = message.text.trim();

        if (userText === "/clear" || userText === "/reset" || userText === "מחק היסטוריה") {
          await this.ctx.storage.delete("history");
          if (tempMsgId) {
            await this.telegram.sendWithMarkdownFallback(
              "editMessageText",
              chatId,
              "🗑️ היסטוריית השיחה נמחקה בהצלחה עבור כבוד הרב. ששון מוכן להתחיל מחדש.",
              tempMsgId
            );
          }
          return;
        }

        if (userText === "/voff") {
          await this.ctx.storage.put("voice_disabled", true);
          if (tempMsgId) {
            await this.telegram.sendWithMarkdownFallback(
              "editMessageText",
              chatId,
              "🔇 שירות ההודעות הקוליות (TTS) כובה עבור כבוד הרב. מעתה ששון ישיב בכתב בלבד.",
              tempMsgId
            );
          }
          return;
        }

        if (userText === "/von") {
          await this.ctx.storage.delete("voice_disabled");
          if (tempMsgId) {
            await this.telegram.sendWithMarkdownFallback(
              "editMessageText",
              chatId,
              "🔊 שירות ההודעות הקוליות (TTS) הופעל עבור כבוד הרב. מעתה ששון ישלח גם הודעה קולית.",
              tempMsgId
            );
          }
          return;
        }

        if (userText === "/soff") {
          await this.ctx.storage.put("stt_disabled", true);
          if (tempMsgId) {
            await this.telegram.sendWithMarkdownFallback(
              "editMessageText",
              chatId,
              "🔇 שירות הזיהוי הקולי (STT) כובה עבור כבוד הרב. מעתה ששון יקבל הודעות טקסט בלבד.",
              tempMsgId
            );
          }
          return;
        }

        if (userText === "/son") {
          await this.ctx.storage.delete("stt_disabled");
          if (tempMsgId) {
            await this.telegram.sendWithMarkdownFallback(
              "editMessageText",
              chatId,
              "🔊 שירות הזיהוי הקולי (STT) הופעל עבור כבוד הרב. מעתה ששון יפענח גם הודעות קוליות.",
              tempMsgId
            );
          }
          return;
        }

        // Service binding triggers
        if (userText === "/news") {
          if (!this.env.NEWS_SERVICE) {
            if (tempMsgId) {
              await this.telegram.sendWithMarkdownFallback("editMessageText", chatId, "⚠️ ששון לא יכול למשוך חדשות: לא הוגדר חיבור שירות עבור NEWS_SERVICE.", tempMsgId);
            }
            return;
          }
          if (tempMsgId) {
            await this.telegram.sendWithMarkdownFallback("editMessageText", chatId, "📰 ששון אוסף ומסנן את מבזקי החדשות האחרונים עבור כבוד הרב...", tempMsgId);
          }
          this.ctx.waitUntil(
            this.env.NEWS_SERVICE.fetch("http://news.local/", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chatId: chatId })
            }).catch(err => console.error("Failed to trigger News Service:", err))
          );
          return;
        }

        if (userText === "/zman") {
          if (!this.env.ZMAN_SERVICE) {
            if (tempMsgId) {
              await this.telegram.sendWithMarkdownFallback("editMessageText", chatId, "⚠️ ששון לא יכול למשוך זמנים: לא הוגדר חיבור שירות עבור ZMAN_SERVICE.", tempMsgId);
            }
            return;
          }
          if (tempMsgId) {
            await this.telegram.sendWithMarkdownFallback("editMessageText", chatId, "📊 ששון אוסף את נתוני מזג האוויר וזמני ההלכה עבור כבוד הרב...", tempMsgId);
          }
          this.ctx.waitUntil(
            this.env.ZMAN_SERVICE.fetch("http://zman.local/", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chatId: chatId, tempMsgId: tempMsgId })
            }).catch(err => console.error("Failed to trigger Zman Service:", err))
          );
          return;
        }

        if (userText === "/lnews") {
          if (!this.env.LNEWS_SERVICE) {
            if (tempMsgId) {
              await this.telegram.sendWithMarkdownFallback("editMessageText", chatId, "⚠️ ששון לא יכול לבדוק שידור חי: לא הוגדר חיבור שירות עבור LNEWS_SERVICE.", tempMsgId);
            }
            return;
          }
          if (tempMsgId) {
            await this.telegram.sendWithMarkdownFallback("editMessageText", chatId, "📺 ששון בודק שידורים חיים בערוץ 14 וב-i24NEWS עבור כבוד הרב...", tempMsgId);
          }
          this.ctx.waitUntil(
            this.env.LNEWS_SERVICE.fetch("http://lnews.local/", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chatId: chatId, tempMsgId: tempMsgId })
            }).catch(err => console.error("Failed to trigger Lnews Service:", err))
          );
          return;
        }

        if (userText === "/movi") {
          if (!this.env.MOVI_SERVICE) {
            if (tempMsgId) {
              await this.telegram.sendWithMarkdownFallback("editMessageText", chatId, "⚠️ ששון לא יכול למשוך סרטון: לא הוגדר חיבור שירות עבור MOVI_SERVICE.", tempMsgId);
            }
            return;
          }
          if (tempMsgId) {
            await this.telegram.sendWithMarkdownFallback("editMessageText", chatId, "🎬 ששון מחפש ומסנן את הסרטון החדש מ-24 השעות האחרונות עבור כבוד הרב...", tempMsgId);
          }
          this.ctx.waitUntil(
            this.env.MOVI_SERVICE.fetch("http://movi.local/", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chatId: chatId, tempMsgId: tempMsgId })
            }).catch(err => console.error("Failed to trigger Movi Service:", err))
          );
          return;
        }
      } else if (message.voice) {
        // 3. Handle Voice Input (STT)
        console.log("Voice note update received from Telegram!");
        const sttDisabled = await this.ctx.storage.get<boolean>("stt_disabled");
        if (sttDisabled) {
          if (tempMsgId) {
            await this.telegram.sendWithMarkdownFallback(
              "editMessageText",
              chatId,
              "🔇 כבוד הרב שלח הודעה קולית, אך שירות הזיהוי הקולי (STT) כבוי כעת. ניתן להפעילו באמצעות הפקודה /son.",
              tempMsgId
            );
          }
          return;
        }

        if (!this.env.STT_SERVICE) {
          throw new Error("STT_SERVICE binding is missing in Environment.");
        }

        await this.telegram.sendChatAction(chatId, "record_voice");

        if (tempMsgId) {
          await this.telegram.sendWithMarkdownFallback("editMessageText", chatId, "📥 שומע ומפענח את הודעת כבוד הרב...", tempMsgId);
        }

        const filePath = await this.telegram.getFilePath(message.voice.file_id);
        const audioBuffer = await this.telegram.downloadFile(filePath);

        console.log("Sending audio bytes to STT Service...");
        const ssttRes = await this.env.STT_SERVICE.fetch("http://sstt.local/", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: audioBuffer
        });

        if (!ssttRes.ok) {
          const errDetails = await ssttRes.text();
          throw new Error("SSTT Service error: " + errDetails);
        }

        const ssttData = (await ssttRes.json()) as { text?: string };
        userText = ssttData.text?.trim() || "";
        console.log("Successfully transcribed text from SSTT:", userText);

        if (!userText) {
          if (tempMsgId) {
            await this.telegram.sendWithMarkdownFallback(
              "editMessageText",
              chatId,
              "⚠️ ששון לא הצלחתי להבין מילים ברורות בהודעה הקולית. אנא נסה שנית או כתוב בטקסט.",
              tempMsgId
            );
          }
          return;
        }
      }

      if (!this.env.TAVILY_API_KEY) {
        throw new Error("TAVILY_API_KEY is missing in environment variables");
      }

      // 4. Load Conversation History from DO Storage
      console.log("5. Reading chat history from DO Storage...");
      let messages = (await this.ctx.storage.get<any[]>("history")) || [];

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
          content: `שמך ששון (Sasson). אתה עוזר וירטואלי אישי בטלגרם לכבוד הרב ובעינייני מדע והייטק וכלכלה ומשאבים וחזון וגיאופוליטיקה, בעל יכולת חיפוש מידע ברשת. התאריך היום: ${formattedDate}. ` +
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

      const activeMessages = [...messages];
      console.log("6. Calling LLM Pipeline Turn 1...");
      const aiResponse = await this.executeLLMPipeline(activeMessages, tools);

      console.log("AI First response output:", JSON.stringify(aiResponse));
      let finalAnswer = "";

      // 5. Tool Calling / Function Execution Loop
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
            await this.telegram.sendWithMarkdownFallback("editMessageText", chatId, "🌐 מבצע חיפוש ברשת עבור כבוד הרב...", tempMsgId);
          }

          console.log("8. Performing Tavily Search API call...");
          let searchResultsStr = "";
          try {
            const tavilyRes = await fetch("https://api.tavily.com/search", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + this.env.TAVILY_API_KEY
              },
              body: JSON.stringify({
                query: searchQuery,
                max_results: 5
              }),
              signal: AbortSignal.timeout(15000)
            });

            if (tavilyRes.ok) {
              const tavilyData = (await tavilyRes.json()) as { results?: TavilyResult[] };
              const results = tavilyData.results || [];
              searchResultsStr = results
                .map((r: TavilyResult) => "Title: " + r.title + "\nURL: " + r.url + "\nContent: " + r.content)
                .join("\n\n");
            } else {
              throw new Error("Tavily returned status " + tavilyRes.status);
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error("Tavily Search failed: " + errMsg);
            searchResultsStr = "שגיאת חיפוש: החיפוש ברשת נכשל או לקח זמן רב מדי עקב עומס זמני. אנא השב לכבוד הרב על בסיס הידע הקיים שלך בלבד ללא תוצאות חיפוש חיות.";
          }

          const toolCallId = toolCall.id || "call_" + Date.now();
          const argsString = typeof args === "string" ? args : JSON.stringify(args || {});

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

          activeMessages.push({
            role: "assistant",
            content: aiResponse.response || "",
            tool_calls: formattedToolCalls
          });

          activeMessages.push({
            role: "tool",
            tool_call_id: toolCallId,
            name: "tavilySearch",
            content: searchResultsStr
          });

          if (tempMsgId) {
            await this.telegram.sendWithMarkdownFallback("editMessageText", chatId, "✍️ מנסח תשובה עבור כבוד הרב...", tempMsgId);
          }

          console.log("9. Calling LLM Pipeline Turn 2, continuing from: " + (aiResponse.provider || "gemini"));
          const finalAiResponse = await this.executeLLMPipeline(activeMessages, tools, aiResponse.provider || "gemini");
          finalAnswer = finalAiResponse.response || "לא התקבלה תשובה סופית.";
        }
      } else {
        console.log("AI responded directly, no tool call needed.");
        finalAnswer = aiResponse.response || "לא הצלחתי לעבד את הפנייה.";
      }

      console.log("10. Final Answer calculated: " + finalAnswer);

      // 6. Persist Updated History to DO Storage
      messages.push({ role: "assistant", content: finalAnswer });
      if (messages.length > 11) {
        messages = this.trimHistorySafely(messages, 10);
      }

      await this.ctx.storage.put("history", messages);
      console.log("11. Conversation history saved in DO storage.");

      // 7. TTS Worker Invocation via Service Binding
      const voiceDisabled = await this.ctx.storage.get<boolean>("voice_disabled");
      if (this.env.TTS_SERVICE && !voiceDisabled) {
        console.log("12. Triggering TTS Worker via Service Binding...");
        this.ctx.waitUntil(this.processTTS(chatId, finalAnswer));
      }

      // 8. Stream Response Chunks to Telegram
      if (tempMsgId) {
        console.log("13. Splitting answer and streaming chunks to Telegram...");
        const chunks = this.chunkText(finalAnswer);

        if (chunks.length > 0) {
          await this.telegram.sendWithMarkdownFallback("editMessageText", chatId, chunks[0], tempMsgId);

          for (let i = 1; i < chunks.length; i++) {
            await this.telegram.sendChatAction(chatId, "typing");
            await new Promise((resolve) => setTimeout(resolve, 800));
            await this.telegram.sendWithMarkdownFallback("sendMessage", chatId, chunks[i]);
          }
        }
      }

      console.log("14. Conversation flow completed successfully.");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error("CRITICAL AI / EXECUTION ERROR:", errMsg);

      if (tempMsgId && chatId) {
        try {
          await this.telegram.send("editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "⚠️ אירעה שגיאה במהלך עיבוד השיחה: " + errMsg
          });
        } catch (teleErr) {
          console.error("Failed to notify user about error:", teleErr);
        }
      }
    }
  }

  // ============================================================================
  // 🤖 3-Tier LLM Pipeline (Gemini ➡️ NVIDIA ➡️ Workers AI)
  // ============================================================================

  private async executeLLMPipeline(
    messages: any[],
    tools?: any[],
    startProvider: LLMProvider = "gemini"
  ): Promise<any> {
    const startIndex = PROVIDER_ORDER.indexOf(startProvider);
    const providersToTry = startIndex >= 0 ? PROVIDER_ORDER.slice(startIndex) : PROVIDER_ORDER;

    let lastErr: any = null;

    for (const provider of providersToTry) {
      try {
        if (provider === "gemini") {
          return await this.callGeminiAPI(messages, tools);
        }

        if (provider === "nvidia") {
          return await this.callNvidiaAPI(messages, tools);
        }

        // Tier 3: Cloudflare Workers AI
        const options: any = {
          messages: messages,
          max_tokens: 1024
        };
        if (tools) options.tools = tools;

        const cfRes = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", options);
        return {
          response: cfRes.response || "",
          tool_calls: cfRes.tool_calls,
          provider: "workers-ai" as LLMProvider
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`Model (${provider}) failed, trying next provider:`, msg);
        lastErr = err;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error("All LLM providers in the pipeline failed.");
  }

  private async callGeminiAPI(messages: any[], tools?: any[]): Promise<any> {
    if (!this.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is missing.");
    }

    const url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    const formattedMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {})
    }));

    const bodyPayload: any = {
      model: "gemini-3.5-flash-lite",
      messages: formattedMessages,
      reasoning_effort: "low",
      max_tokens: 1536
    };

    if (tools) bodyPayload.tools = tools;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + this.env.GEMINI_API_KEY
      },
      body: JSON.stringify(bodyPayload),
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Google Gemini API error [${response.status}]: ${errText}`);
    }

    const resJson = (await response.json()) as any;
    const choice = resJson?.choices?.[0];

    return {
      response: choice?.message?.content || "",
      tool_calls: choice?.message?.tool_calls,
      provider: "gemini" as LLMProvider
    };
  }

  private async callNvidiaAPI(messages: any[], tools?: any[]): Promise<any> {
    if (!this.env.NVIDIA_API_KEY) {
      throw new Error("NVIDIA_API_KEY is missing.");
    }

    const nvidiaUrl = "https://integrate.api.nvidia.com/v1/chat/completions";
    const formattedMessages = messages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      ...(m.name ? { name: m.name } : {})
    }));

    const bodyPayload: any = {
      model: "nvidia/nemotron-3-super-120b-a12b",
      messages: formattedMessages,
      temperature: 1,
      top_p: 0.95,
      max_tokens: 1536
    };

    if (tools) bodyPayload.tools = tools;

    const response = await fetch(nvidiaUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + this.env.NVIDIA_API_KEY
      },
      body: JSON.stringify(bodyPayload),
      signal: AbortSignal.timeout(20000)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`NVIDIA API error [${response.status}]: ${errText}`);
    }

    const resJson = (await response.json()) as any;
    const choice = resJson?.choices?.[0];

    return {
      response: choice?.message?.content || "",
      tool_calls: choice?.message?.tool_calls,
      provider: "nvidia" as LLMProvider
    };
  }

  // ============================================================================
  // 🔊 Audio & Helper Utilities
  // ============================================================================

  private async processTTS(chatId: string, text: string): Promise<void> {
    try {
      if (!this.env.TTS_SERVICE) return;
      const cleanTextForTTS = this.stripMarkdownAndEmojis(text);

      const ttsRes = await this.env.TTS_SERVICE.fetch("http://ttss.local/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: cleanTextForTTS,
          voice: "he-IL-AvriNeural",
          speed: 1.5
        })
      });

      if (!ttsRes.ok) {
        const errText = await ttsRes.text();
        console.error("TTS Worker error: " + errText);
        return;
      }

      const audioBuffer = await ttsRes.arrayBuffer();
      const sendRes = await this.telegram.sendVoice(chatId, audioBuffer);
      if (!sendRes.ok) {
        console.error("Failed to send voice to Telegram:", sendRes.description);
      } else {
        console.log("Voice message successfully delivered to Telegram.");
      }
    } catch (err) {
      console.error("Failed to process TTS voice message:", err);
    }
  }

  private stripMarkdownAndEmojis(text: string): string {
    return text
      .replace(/[*_`#~[\]()]/g, "")
      .replace(/[\u{1F300}-\u{1F9FF}]/gu, "")
      .replace(/[\u{2700}-\u{27BF}]/gu, "")
      .replace(/[\u{2600}-\u{26FF}]/gu, "")
      .replace(/[\r\n]+/g, " ")
      .trim();
  }

  private trimHistorySafely(messages: any[], maxNonSystem: number = 10): any[] {
    if (messages.length === 0) return messages;
    const hasSystem = messages[0]?.role === "system";
    const systemMsg = hasSystem ? messages[0] : null;
    const rest = hasSystem ? messages.slice(1) : messages;

    let trimmed = rest.slice(-maxNonSystem);

    while (trimmed.length > 0 && trimmed[0]?.role === "tool") {
      trimmed = trimmed.slice(1);
    }

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

  private chunkText(text: string): string[] {
    const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
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
                                        }
