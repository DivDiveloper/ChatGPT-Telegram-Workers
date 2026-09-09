// ============================================================================
// 1. ממשקים מקומיים (ללא תלות בספריות חיצוניות)
// ============================================================================

interface LocalDOStorage {
  get<T = any>(key: string): Promise<T | undefined>;
  put<T = any>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

interface LocalDOState {
  storage: LocalDOStorage;
  waitUntil(promise: Promise<any>): void;
}

interface LocalDOStub {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>;
}

interface LocalDONamespace {
  idFromName(name: string): any;
  get(id: any): LocalDOStub;
}

interface LocalExecutionContext {
  waitUntil(promise: Promise<any>): void;
}

interface LocalFetcher {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>;
}

export interface Env {
  CHAT_SESSION: LocalDONamespace;
  DATABASE: any;
  AI: any;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_SECRET_TOKEN?: string;
  TAVILY_API_KEY: string;
  GEMINI_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  ALLOWED_USER_IDS?: string;

  TTS_SERVICE?: LocalFetcher;
  STT_SERVICE?: LocalFetcher;
  NEWS_SERVICE?: LocalFetcher;
  ZMAN_SERVICE?: LocalFetcher;
  LNEWS_SERVICE?: LocalFetcher;
  MOVI_SERVICE?: LocalFetcher;

  // שינוי 1: Service Binding ל-Sefaria
  SEFARIA_SEARCH?: LocalFetcher;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      is_bot: boolean;
      first_name: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    date: number;
    text?: string;
    voice?: {
      file_id: string;
    };
  };
  callback_query?: {
    id: string;
    from: {
      id: number;
    };
    message?: {
      chat: {
        id: number;
      };
      message_id: number;
    };
    data?: string;
  };
}

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

export interface TelegramGetFileResult {
  ok: boolean;
  result?: {
    file_path?: string;
  };
  description?: string;
}

export type LLMProvider = "gemini" | "nvidia" | "workers-ai";
const PROVIDER_ORDER: LLMProvider[] = ["gemini", "nvidia", "workers-ai"];

// ============================================================================
// 2. ה-Worker הדק (Router)
// ============================================================================

export default {
  async fetch(request: Request, env: Env, ctx: LocalExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (env.TELEGRAM_SECRET_TOKEN) {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secretHeader !== env.TELEGRAM_SECRET_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    let update: TelegramUpdate;
    try {
      update = (await request.json()) as TelegramUpdate;
    } catch {
      return new Response("Invalid JSON", { status: 200 });
    }

    const chatId =
      update.message?.chat?.id ??
      update.callback_query?.message?.chat?.id ??
      update.callback_query?.from?.id;

    if (!chatId) {
      return new Response(JSON.stringify({ ok: true, skipped: "no_chat_id" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (env.ALLOWED_USER_IDS) {
      const senderId = update.message?.from?.id ?? update.callback_query?.from?.id;
      const allowedList = env.ALLOWED_USER_IDS.split(",").map((id) => id.trim());
      if (senderId && !allowedList.includes(String(senderId))) {
        return new Response(JSON.stringify({ ok: true, skipped: "unauthorized_user" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    try {
      const doId = env.CHAT_SESSION.idFromName(chatId.toString());
      const stub = env.CHAT_SESSION.get(doId);

      ctx.waitUntil(
        stub.fetch("http://do/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update)
        }).then(async (res) => {
          if (!res.ok) {
            const errText = await res.text();
            console.error(`DO returned error status ${res.status}:`, errText);
          }
        }).catch((err) => {
          console.error(`Failed to reach DO for chat ${chatId}:`, err);
        })
      );
    } catch (err) {
      console.error("Failed to route to DO:", err);
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
};

// ============================================================================
// 3. מחלקת ה-Durable Object הייעודית (ChatbotSessionDO)
// ============================================================================

export class ChatbotSessionDO {
  private state: LocalDOState;
  private env: Env;
  private queue: Promise<void> = Promise.resolve();

  constructor(state: LocalDOState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const update = (await request.json()) as TelegramUpdate;
      
      this.state.waitUntil(
        this.queue = this.queue
          .then(() => this.processTelegramUpdate(update))
          .catch((err) => {
            console.error("Unhandled error in DO task execution:", err);
          })
      );

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    } catch (err: any) {
      console.error("Error in DO fetch handler:", err);
      return new Response(err?.message || "Internal DO Error", { status: 500 });
    }
  }

  private async processTelegramUpdate(update: TelegramUpdate): Promise<void> {
    console.log("1. Received Telegram update payload:", JSON.stringify(update));

    let tempMsgId: number | undefined = undefined;
    let chatId = "";
    let stopTypingHeartbeat: (() => void) | null = null;

    try {
      const message = update.message;
      if (!message) return;
      if (!message.text && !message.voice) return;

      chatId = message.chat.id.toString();
      let userText = "";

      if (!this.env.TELEGRAM_BOT_TOKEN) {
        throw new Error("Missing TELEGRAM_BOT_TOKEN environment variable");
      }

      // הפעלת פעימות אינדיקטור הקלדה רציף בטלגרם
      stopTypingHeartbeat = this.startTypingHeartbeat(chatId);

      console.log("3. Sending initial 'thinking' message to Telegram...");
      const thinkingMsg = await this.sendTelegram("sendMessage", {
        chat_id: chatId,
        text: "🔍 מעבד את פניית כבוד הרב..."
      });

      if (!thinkingMsg || !thinkingMsg.ok) {
        throw new Error("Failed to send initial message: " + (thinkingMsg?.description || ""));
      }

      tempMsgId = thinkingMsg.result?.message_id;

      // א. פקודות טקסט
      if (message.text) {
        userText = message.text.trim();

        // שינוי 3: /sfr מטופל בקוד ולא בפרומפט
        const forceSefaria = userText.startsWith("/sfr");
        if (forceSefaria) {
          userText = userText.slice(4).trim();

          if (!userText) {
            if (tempMsgId) {
              await this.sendTelegram("editMessageText", {
                chat_id: chatId,
                message_id: tempMsgId,
                text: "📖 נא לציין את השאלה או המקור לחיפוש בסיפריא."
              });
            }
            return;
          }
        }

        if (userText === "/clear" || userText === "/reset" || userText === "מחק היסטוריה") {
          await this.state.storage.delete("history");
          if (tempMsgId) {
            await this.sendTelegram("editMessageText", {
              chat_id: chatId,
              message_id: tempMsgId,
              text: "🗑️ היסטוריית השיחה נמחקה בהצלחה עבור כבוד הרב. ששון מוכן להתחיל מחדש."
            });
          }
          return;
        }

        if (userText === "/voff") {
          await this.state.storage.put("voice_disabled", true);
          if (tempMsgId) {
            await this.sendTelegram("editMessageText", {
              chat_id: chatId,
              message_id: tempMsgId,
              text: "🔇 שירות ההודעות הקוליות (TTS) כובה עבור כבוד הרב. מעתה ששון ישיב בכתב בלבד."
            });
          }
          return;
        }

        if (userText === "/von") {
          await this.state.storage.delete("voice_disabled");
          if (tempMsgId) {
            await this.sendTelegram("editMessageText", {
              chat_id: chatId,
              message_id: tempMsgId,
              text: "🔊 שירות ההודעות הקוליות (TTS) הופעל עבור כבוד הרב. מעתה ששון ישלח גם הודעה קולית."
            });
          }
          return;
        }

        if (userText === "/soff") {
          await this.state.storage.put("stt_disabled", true);
          if (tempMsgId) {
            await this.sendTelegram("editMessageText", {
              chat_id: chatId,
              message_id: tempMsgId,
              text: "🔇 שירות הזיהוי הקולי (STT) כובה עבור כבוד הרב. מעתה ששון יקבל הודעות טקסט בלבד."
            });
          }
          return;
        }

        if (userText === "/son") {
          await this.state.storage.delete("stt_disabled");
          if (tempMsgId) {
            await this.sendTelegram("editMessageText", {
              chat_id: chatId,
              message_id: tempMsgId,
              text: "🔊 שירות הזיהוי הקולי (STT) הופעל עבור כבוד הרב. מעתה ששון יפענח גם הודעות קוליות."
            });
          }
          return;
        }

        if (userText === "/news") {
          if (!this.env.NEWS_SERVICE) {
            if (tempMsgId) {
              await this.sendTelegram("editMessageText", {
                chat_id: chatId,
                message_id: tempMsgId,
                text: "⚠️ לא הוגדר חיבור עבור NEWS_SERVICE."
              });
            }
            return;
          }

          if (tempMsgId) {
            await this.sendTelegram("editMessageText", {
              chat_id: chatId,
              message_id: tempMsgId,
              text: "📰 ששון אוסף ומסנן את מבזקי החדשות האחרונים עבור כבוד הרב..."
            });
          }

          this.state.waitUntil(
            this.env.NEWS_SERVICE.fetch("http://news.local/", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chatId: chatId })
            }).catch((err) => console.error("Failed News Service:", err))
          );
          return;
        }

        if (userText === "/zman") {
          if (!this.env.ZMAN_SERVICE) {
            if (tempMsgId) {
              await this.sendTelegram("editMessageText", {
                chat_id: chatId,
                message_id: tempMsgId,
                text: "⚠️ לא הוגדר חיבור עבור ZMAN_SERVICE."
              });
            }
            return;
          }

          if (tempMsgId) {
            await this.sendTelegram("editMessageText", {
              chat_id: chatId,
              message_id: tempMsgId,
              text: "📊 ששון אוסף את נתוני מזג האוויר וזמני ההלכה עבור כבוד הרב..."
            });
          }

          this.state.waitUntil(
            this.env.ZMAN_SERVICE.fetch("http://zman.local/", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chatId: chatId, tempMsgId: tempMsgId })
            }).catch((err) => console.error("Failed Zman Service:", err))
          );
          return;
        }

        if (userText === "/lnews") {
          if (!this.env.LNEWS_SERVICE) {
            if (tempMsgId) {
              await this.sendTelegram("editMessageText", {
                chat_id: chatId,
                message_id: tempMsgId,
                text: "⚠️ לא הוגדר חיבור עבור LNEWS_SERVICE."
              });
            }
            return;
          }

          if (tempMsgId) {
            await this.sendTelegram("editMessageText", {
              chat_id: chatId,
              message_id: tempMsgId,
              text: "📺 ששון בודק שידורים חיים בערוץ 14 וב-i24NEWS עבור כבוד הרב..."
            });
          }

          this.state.waitUntil(
            this.env.LNEWS_SERVICE.fetch("http://lnews.local/", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chatId: chatId, tempMsgId: tempMsgId })
            }).catch((err) => console.error("Failed Lnews Service:", err))
          );
          return;
        }

        if (userText === "/movi") {
          if (!this.env.MOVI_SERVICE) {
            if (tempMsgId) {
              await this.sendTelegram("editMessageText", {
                chat_id: chatId,
                message_id: tempMsgId,
                text: "⚠️ לא הוגדר חיבור עבור MOVI_SERVICE."
              });
            }
            return;
          }

          if (tempMsgId) {
            await this.sendTelegram("editMessageText", {
              chat_id: chatId,
              message_id: tempMsgId,
              text: "🎬 ששון מחפש את הסרטון החדש מ-24 השעות האחרונות עבור כבוד הרב..."
            });
          }

          this.state.waitUntil(
            this.env.MOVI_SERVICE.fetch("http://movi.local/", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chatId: chatId, tempMsgId: tempMsgId })
            }).catch((err) => console.error("Failed Movi Service:", err))
          );
          return;
        }
      } else if (message.voice) {
        // ב. קלט קולי (STT)
        const sttDisabled = await this.state.storage.get<boolean>("stt_disabled");
        if (sttDisabled) {
          if (tempMsgId) {
            await this.sendTelegram("editMessageText", {
              chat_id: chatId,
              message_id: tempMsgId,
              text: "🔇 שירות הזיהוי הקולי כבוי כעת. ניתן להפעילו עם /son."
            });
          }
          return;
        }

        const sttService = this.env.STT_SERVICE;
        if (!sttService) throw new Error("STT_SERVICE binding missing.");

        if (tempMsgId) {
          await this.sendTelegram("editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: "📥 שומע ומפענח את הודעת כבוד הרב..."
          });
        }

        const fileId = message.voice.file_id;
        const getFileUrl = `https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`;
        const fileInfoRes = await fetch(getFileUrl, { signal: AbortSignal.timeout(15000) });
        const fileInfo = (await fileInfoRes.json()) as TelegramGetFileResult;

        if (!fileInfo.ok || !fileInfo.result?.file_path) {
          throw new Error("Failed to get voice file path from Telegram.");
        }

        const filePath = fileInfo.result.file_path;
        const voiceFileRes = await fetch(
          `https://api.telegram.org/file/bot${this.env.TELEGRAM_BOT_TOKEN}/${filePath}`,
          { signal: AbortSignal.timeout(15000) }
        );

        const audioBuffer = await voiceFileRes.arrayBuffer();
        const ssttRes = await sttService.fetch("http://sstt.local/", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: audioBuffer
        });

        const ssttData = (await ssttRes.json()) as { text?: string };
        userText = ssttData.text?.trim() || "";

        if (!userText) {
          if (tempMsgId) {
            await this.sendTelegram("editMessageText", {
              chat_id: chatId,
              message_id: tempMsgId,
              text: "⚠️ לא הצלחתי לפענח מילים ברורות בהודעה הקולית."
            });
          }
          return;
        }
      }
  const activeMessages = [...messages];
  
  // =========================================================================
  // 🔄 לולאת סוכן חכם (Agent Loop): עד 3 סבבי חיפוש עוקבים
  // =========================================================================
  const MAX_SEARCH_ROUNDS = 3;
  let round = 0;
  let finalAnswer = "";
  let currentProvider: LLMProvider = "gemini";

  while (round < MAX_SEARCH_ROUNDS) {
    round++;
    console.log(`Agent Loop Turn ${round}/${MAX_SEARCH_ROUNDS}...`);

    const aiResponse = await this.executeLLMPipeline(activeMessages, tools, currentProvider);
    currentProvider = aiResponse.provider || currentProvider;

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

        const finalQuery = (searchQuery || userText).trim();

        if (tempMsgId) {
          await this.sendTelegram("editMessageText", {
            chat_id: chatId,
            message_id: tempMsgId,
            text: `🌐 מבצע חיפוש מעמיק ברשת (${round}/${MAX_SEARCH_ROUNDS}) עבור כבוד הרב...`
          });
        }

        let searchResultsStr = "";
        try {
          const tavilyRes = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + this.env.TAVILY_API_KEY
            },
            body: JSON.stringify({
              query: finalQuery,
              max_results: 6
            }),
            signal: AbortSignal.timeout(15000)
          });

          if (tavilyRes.ok) {
            const tavilyData = (await tavilyRes.json()) as { results?: TavilyResult[] };
            const results = tavilyData.results || [];
            searchResultsStr = results
              .map((r: TavilyResult) => `Title: ${r.title}\nURL: ${r.url}\nContent: ${r.content}`)
              .join("\n\n");
          } else {
            throw new Error("Tavily returned " + tavilyRes.status);
          }
        } catch (err) {
          searchResultsStr = "שגיאת חיפוש: החיפוש ברשת נכשל. אנא השב על בסיס הידע הקיים שלך.";
        }

        const toolCallId = toolCall.id || `call_${Date.now()}_${round}`;
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

        // ממשיכים לסיבוב הבא בלולאה
        continue;
      } else {
        finalAnswer = aiResponse.response?.trim() || "";
        break;
      }
    } else {
      // המודל החזיר תשובה טקסטואלית מוכנה ואינו זקוק לחיפוש נוסף
      finalAnswer = aiResponse.response?.trim() || "";
      break;
    }
  }

  // ניסוח תשובה סופית אם הסתיימו 3 סבבים
  if (!finalAnswer) {
    if (tempMsgId) {
      await this.sendTelegram("editMessageText", {
        chat_id: chatId,
        message_id: tempMsgId,
        text: "✍️ מנסח תשובה מקיפה עבור כבוד הרב..."
      });
    }

    const finalAiResponse = await this.executeLLMPipeline(
      activeMessages,
      undefined, // ללא tools כדי לאלץ כתיבת טקסט סופי
      currentProvider
    );
    finalAnswer = finalAiResponse.response?.trim() || "";

    if (!finalAnswer) {
      activeMessages.push({
        role: "user",
        content: "אנא נסח כעת את התשובה המלאה והסופית עבור כבוד הרב מתוך כל תוצאות החיפוש שנאספו לעיל."
      });
      const retryAi = await this.executeLLMPipeline(activeMessages, undefined, "gemini");
      finalAnswer = retryAi.response?.trim() || "לא הצלחתי לעבד את תוצאות החיפוש. אנא נסה שוב.";
    }
  }

  console.log("10. Final Answer calculated:", finalAnswer);

  messages.push({ role: "assistant", content: finalAnswer });

  if (messages.length > 16) {
    messages = this.trimHistorySafely(messages, 15);
  }

  await this.state.storage.put("history", messages);

  // ה. פלט קולי (TTS)
  const voiceDisabled = await this.state.storage.get<boolean>("voice_disabled");
  const ttsService = this.env.TTS_SERVICE;

  if (ttsService && !voiceDisabled) {
    this.state.waitUntil(
      (async () => {
        try {
          const cleanTextForTTS = this.stripMarkdownAndEmojis(finalAnswer);

          const ttsRes = await ttsService.fetch("http://ttss.local/v1/audio/speech", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              input: cleanTextForTTS,
              voice: "he-IL-AvriNeural",
              speed: 1.4
            })
          });

          if (!ttsRes.ok) {
            const errorText = await ttsRes.text();
            console.error("TTSS returned error:", ttsRes.status, errorText);
            return;
          }

          const reader = ttsRes.body?.getReader();

          if (!reader) {
            throw new Error("TTS Worker returned no readable stream.");
          }

          const audioChunks: Uint8Array[] = [];
          let totalLength = 0;

          while (true) {
            const { done, value } = await reader.read();

            if (done) break;

            if (value && value.length > 0) {
              audioChunks.push(value);
              totalLength += value.length;
            }
          }

          const audioBuffer = new Uint8Array(totalLength);
          let offset = 0;

          for (const chunk of audioChunks) {
            audioBuffer.set(chunk, offset);
            offset += chunk.length;
          }

          const formData = new FormData();

          formData.append("chat_id", chatId);

          formData.append(
            "voice",
            new Blob([audioBuffer], { type: "audio/mpeg" }),
            "voice.mp3"
          );

          const telegramRes = await fetch(
            `https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendVoice`,
            {
              method: "POST",
              body: formData,
              signal: AbortSignal.timeout(20000)
            }
          );

          if (!telegramRes.ok) {
            const errorText = await telegramRes.text();
            console.error("Telegram sendVoice failed:", telegramRes.status, errorText);
          }
        } catch (ttsErr) {
          console.error("Failed TTS Worker:", ttsErr);
        }
      })()
    );
  }

  // ו. שידור מדורג בטלגרם
  if (tempMsgId) {
    const chunks = this.chunkText(finalAnswer);

    if (chunks.length > 0) {
      await this.sendTelegramWithMarkdownFallback(chatId, tempMsgId, chunks[0]);

      for (let i = 1; i < chunks.length; i++) {
        await this.sendTelegram("sendChatAction", {
          chat_id: chatId,
          action: "typing"
        });

        await new Promise((resolve) => setTimeout(resolve, 800));
        await this.sendNewTelegramWithMarkdownFallback(chatId, chunks[i]);
      }
    }
  }
} catch (err) {
  const errMsg = err instanceof Error ? err.message : String(err);
  console.error("CRITICAL DO Error: " + errMsg);

  if (tempMsgId && chatId) {
    try {
      await this.sendTelegram("editMessageText", {
        chat_id: chatId,
        message_id: tempMsgId,
        text: "⚠️ אירעה שגיאה במהלך עיבוד השיחה: " + errMsg
      });
    } catch (teleErr) {
      console.error("Failed to notify user:", teleErr);
    }
  }
} finally {
  if (stopTypingHeartbeat) {
    stopTypingHeartbeat();
  }
}
