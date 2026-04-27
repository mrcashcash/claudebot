import type { Context, Telegraf, Types } from "telegraf";

type TelegramClient = Telegraf["telegram"];
type SendMessageReturn = ReturnType<TelegramClient["sendMessage"]>;
type SendChatActionArg = Parameters<TelegramClient["sendChatAction"]>[1];

/**
 * A minimal IO surface for a turn — enough for runTurn, buildCanUseTool,
 * and questions.ask to send/edit Telegram messages without a Telegraf
 * `Context`. Handlers build it from `ctx`; the cron runner builds it from
 * `bot.telegram`. This is what lets a scheduled prompt fire end-to-end
 * without an incoming update.
 */
export interface TurnIO {
  chatId: number;
  reply(text: string, extra?: Types.ExtraReplyMessage): SendMessageReturn;
  sendChatAction(action: SendChatActionArg): Promise<true>;
  telegram: TelegramClient;
}

export function ioFromContext(ctx: Context): TurnIO {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) {
    throw new Error("ioFromContext: ctx.chat is undefined");
  }
  return {
    chatId,
    reply: (text, extra) => ctx.telegram.sendMessage(chatId, text, extra),
    sendChatAction: (action) => ctx.telegram.sendChatAction(chatId, action),
    telegram: ctx.telegram,
  };
}

export function ioFromTelegram(
  telegram: TelegramClient,
  chatId: number,
): TurnIO {
  return {
    chatId,
    reply: (text, extra) => telegram.sendMessage(chatId, text, extra),
    sendChatAction: (action) => telegram.sendChatAction(chatId, action),
    telegram,
  };
}
