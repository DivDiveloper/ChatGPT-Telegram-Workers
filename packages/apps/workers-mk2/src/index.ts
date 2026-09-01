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

      if (!this.env.TAVILY_API_KEY) throw new Error("TAVILY_API_KEY is missing.");

      // ג. היסטוריה מ-DO Storage
      let messages: any[] = (await this.state.storage.get<any[]>("history")) || [];

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
          content:
            `שמך ששון (Sasson). אתה עוזר וירטואלי אישי בטלגרם לכבוד הרב ובעינייני מדע והייטק וכלכלה ומשאבים וחזון וגיאופוליטיקה, בעל יכולת חיפוש מידע ברשת. התאריך היום: ${formattedDate}. ` +
            `עליך לפנות למשתמש תמיד בכינוי 'כבוד הרב' בלשון מכבד, ביראת כבוד, לשמור על כבוד התורה ולציית לציוויו. ` +
            `אל תבצע שום חשיבה מקדימה כלל (לא לחשוב כלל חשיבה מקדימה), אל תציג מחשבות פנימיות, מונולוגים או השערות כפלט, אלא גש ישירות ומיד למתן התשובה הסופית. ` +
            `ענה בעברית רהוטה, ממוקדת, קומפקטית וחסכונית במילים (בסביבות 220-240 מילים לכל היותר, ללא הקדמות או סיכומים מיותרים). ` +
            `במידת האפשר והרלוונטיות, העדף תמיד לשלב קישורים ישירים לתמונות ווידאו (כגון YouTube או קובצי מדיה) שיוטמעו ויוצגו ישירות בתצוגה מקדימה בשיחה בטלגרם. ` +
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

              if (!ttsRes.ok) return;

              const audioBuffer = await ttsRes.arrayBuffer();
              const formData = new FormData();
              formData.append("chat_id", chatId);
              formData.append("voice", new Blob([audioBuffer], { type: "audio/mpeg" }), "voice.mp3");

              await fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendVoice`, {
                method: "POST",
                body: formData,
                signal: AbortSignal.timeout(20000)
              });
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
  }

  // ============================================================================
  // 4. עזר לשליחת אינדיקטור הקלדה רציף ברקע
  // ============================================================================
  private startTypingHeartbeat(chatId: string): () => void {
    let isActive = true;
    this.sendTelegram("sendChatAction", { chat_id: chatId, action: "typing" });

    const intervalId = setInterval(() => {
      if (!isActive) {
        clearInterval(intervalId);
        return;
      }
      this.sendTelegram("sendChatAction", { chat_id: chatId, action: "typing" });
    }, 4500);

    return () => {
      isActive = false;
      clearInterval(intervalId);
    };
  }

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
          const res = await this.callGeminiAPI(messages, tools);
          if (res.response || (res.tool_calls && res.tool_calls.length > 0)) {
            return res;
          }
        }

        if (provider === "nvidia") {
          const res = await this.callNvidiaAPI(messages, tools);
          if (res.response || (res.tool_calls && res.tool_calls.length > 0)) {
            return res;
          }
        }

        const options: any = {
          messages: messages,
          max_tokens: 1230
        };
        if (tools) options.tools = tools;

        const cfRes = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", options);
        return {
          response: cfRes.response || "",
          tool_calls: cfRes.tool_calls,
          provider: "workers-ai" as LLMProvider
        };
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr instanceof Error ? lastErr : new Error("All LLM providers failed.");
  }

  private async callGeminiAPI(messages: any[], tools?: any[]): Promise<any> {
    if (!this.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is missing.");
    }

    const url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    const formattedMessages = messages.map((m) => {
      const msg: any = { role: m.role, content: m.content };
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.name) msg.name = m.name;
      return msg;
    });

    const bodyPayload: any = {
      model: "gemini-3.5-flash-lite",
      messages: formattedMessages,
      reasoning_effort: "low",
      max_tokens: 1840
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
      throw new Error("Google Gemini API returned status " + response.status + ". Details: " + errText);
    }

    const resJson = (await response.json()) as any;
    const choice = resJson?.choices?.[0];

    const content =
      choice?.message?.content ||
      choice?.message?.reasoning_content ||
      choice?.text ||
      "";

    return {
      response: content,
      tool_calls: choice?.message?.tool_calls,
      provider: "gemini" as LLMProvider
    };
  }

  private async callNvidiaAPI(messages: any[], tools?: any[]): Promise<any> {
    if (!this.env.NVIDIA_API_KEY) {
      throw new Error("NVIDIA_API_KEY is missing.");
    }

    const nvidiaUrl = "https://integrate.api.nvidia.com/v1/chat/completions";
    const formattedMessages = messages.map((m) => {
      const msg: any = { role: m.role, content: m.content };
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      if (m.name) msg.name = m.name;
      return msg;
    });

    const bodyPayload: any = {
      model: "nvidia/nemotron-3-super-120b-a12b",
      messages: formattedMessages,
      temperature: 1,
      top_p: 0.95,
      max_tokens: 1840
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
      throw new Error("NVIDIA API returned status " + response.status + ". Details: " + errText);
    }

    const resJson = (await response.json()) as any;
    const choice = resJson?.choices?.[0];

    const content =
      choice?.message?.content ||
      choice?.message?.reasoning_content ||
      choice?.text ||
      "";

    return {
      response: content,
      tool_calls: choice?.message?.tool_calls,
      provider: "nvidia" as LLMProvider
    };
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

  private trimHistorySafely(messages: any[], maxNonSystem: number = 15): any[] {
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
      if (currentChunk.length + para.length + 2 > 720) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = "";
        }
        if (para.length > 720) {
          let temp = para;
          while (temp.length > 720) {
            chunks.push(temp.substring(0, 720));
            temp = temp.substring(720);
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

  private async sendTelegram(method: string, payload: any): Promise<any> {
    const url = `https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/${method}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    return response.json();
  }

  private async sendTelegramWithMarkdownFallback(
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

    const res = await this.sendTelegram("editMessageText", payloadMarkdown);
    if (!res.ok) {
      await this.sendTelegram("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: text
      });
    }
  }

  private async sendNewTelegramWithMarkdownFallback(chatId: string, text: string): Promise<any> {
    const payloadMarkdown = {
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown"
    };

    let res = await this.sendTelegram("sendMessage", payloadMarkdown);
    if (!res.ok) {
      res = await this.sendTelegram("sendMessage", {
        chat_id: chatId,
        text: text
      });
    }
    return res;
  }
}
