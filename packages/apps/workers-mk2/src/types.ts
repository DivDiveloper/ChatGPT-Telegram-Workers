export interface Env {
  // Durable Object Namespace Binding
  CHAT_SESSION: DurableObjectNamespace<import("./ChatSessionDO").ChatSessionDO>;

  // Legacy KV (kept for backward compatibility or global lookups)
  DATABASE?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
  };

  // Cloudflare Workers AI Binding
  AI: any;

  // Secrets & API Keys
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_SECRET_TOKEN?: string;
  TAVILY_API_KEY: string;
  GEMINI_API_KEY?: string;
  NVIDIA_API_KEY?: string;
  ALLOWED_USER_IDS?: string;

  // Cloudflare Service Bindings
  TTS_SERVICE?: Fetcher;
  STT_SERVICE?: Fetcher;
  NEWS_SERVICE?: Fetcher;
  ZMAN_SERVICE?: Fetcher;
  LNEWS_SERVICE?: Fetcher;
  MOVI_SERVICE?: Fetcher;
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
