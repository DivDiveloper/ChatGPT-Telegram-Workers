import { Env } from "./types";

export class TelegramClient {
  private readonly baseUrl: string;

  constructor(private readonly token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  async send(method: string, payload: any): Promise<any> {
    const res = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    return res.json();
  }

  async sendChatAction(chatId: string, action: string = "typing"): Promise<any> {
    return this.send("sendChatAction", { chat_id: chatId, action });
  }

  async sendWithMarkdownFallback(
    method: "sendMessage" | "editMessageText",
    chatId: string,
    text: string,
    messageId?: number
  ): Promise<any> {
    const payload: any = {
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown"
    };
    if (messageId) {
      payload.message_id = messageId;
    }

    let res = await this.send(method, payload);
    if (!res.ok) {
      delete payload.parse_mode;
      res = await this.send(method, payload);
    }
    return res;
  }

  async sendVoice(chatId: string, audioBuffer: ArrayBuffer): Promise<any> {
    const formData = new FormData();
    formData.append("chat_id", chatId);
    formData.append("voice", new Blob([audioBuffer], { type: "audio/mpeg" }), "voice.mp3");

    const res = await fetch(`${this.baseUrl}/sendVoice`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(20000)
    });
    return res.json();
  }

  async getFilePath(fileId: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/getFile?file_id=${encodeURIComponent(fileId)}`, {
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
      throw new Error(`Telegram getFile API returned status ${res.status}`);
    }
    const data = (await res.json()) as any;
    if (!data.ok || !data.result?.file_path) {
      throw new Error(`Failed to retrieve voice file path: ${data.description || ""}`);
    }
    return data.result.file_path;
  }

  async downloadFile(filePath: string): Promise<ArrayBuffer> {
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`, {
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
      throw new Error(`Failed to download file from Telegram: ${res.status}`);
    }
    return res.arrayBuffer();
  }
}
