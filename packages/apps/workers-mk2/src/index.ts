import { Env, TelegramUpdate } from "./types";

// ⚠️ חובה לייצא את מחלקת ה-Durable Object כדי ש-Cloudflare Workers יכיר את ה-Binding
export { ChatSessionDO } from "./ChatSessionDO";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 1. קבלת בקשות מסוג POST בלבד (טלגרם שולח Webhook ב-POST)
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 2. אימות Secret Token של טלגרם (אם מוגדר ב-Secrets לאבטחה)
    if (env.TELEGRAM_SECRET_TOKEN) {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secretHeader !== env.TELEGRAM_SECRET_TOKEN) {
        console.warn("Unauthorized webhook request: Secret Token mismatch.");
        return new Response("Unauthorized", { status: 401 });
      }
    }

    // 3. פענוח מהיר של ה-JSON מטלגרם
    let update: TelegramUpdate;
    try {
      update = (await request.json()) as TelegramUpdate;
    } catch (err) {
      console.error("Failed to parse incoming Telegram JSON:", err);
      // מחזירים 200 כדי שטלגרם לא ימשיך להפציץ את השרת בבקשות שבורות
      return new Response("Invalid JSON", { status: 200 });
    }

    // 4. חילוץ ה-chatId או ה-userId לניתוב ה-Durable Object
    const chatId =
      update.message?.chat?.id ??
      update.callback_query?.message?.chat?.id ??
      update.callback_query?.from?.id;

    if (!chatId) {
      // אם העדכון אינו מכיל מזהה שיחה (למשל עדכון ערוץ/סטטוס לא רלוונטי), מאשרים ומדלגים
      return new Response(JSON.stringify({ ok: true, skipped: "no_chat_id" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 5. סינון מורשים (אופציונלי: אם הגדרת רשימת מורשים ב-ALLOWED_USER_IDS)
    if (env.ALLOWED_USER_IDS) {
      const senderId = update.message?.from?.id ?? update.callback_query?.from?.id;
      const allowedList = env.ALLOWED_USER_IDS.split(",").map((id) => id.trim());
      if (senderId && !allowedList.includes(String(senderId))) {
        console.warn(`Blocked unauthorized access attempt from User ID: ${senderId}`);
        return new Response(JSON.stringify({ ok: true, skipped: "unauthorized_user" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    try {
      // 6. הפקת מזהה ייחודי ל-Durable Object לפי ה-Chat ID
      const doId = env.CHAT_SESSION.idFromName(chatId.toString());
      const stub = env.CHAT_SESSION.get(doId);

      // 7. הרצת כל לוגיקת העיבוד, ה-AI והכלים בתוך ה-Durable Object ברקע
      ctx.waitUntil(
        stub.handleUpdate(update).catch((err: unknown) => {
          console.error(`Error executing ChatSessionDO for Chat ID ${chatId}:`, err);
        })
      );
    } catch (err) {
      console.error("Failed to forward update to Durable Object:", err);
    }

    // 8. החזרת אישור מיידי (200 OK) לטלגרם תוך מילי-שניות בודדות
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
};
