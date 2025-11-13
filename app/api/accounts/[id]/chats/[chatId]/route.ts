import { NextRequest, NextResponse } from 'next/server';
import { whatsappManager } from '@/lib/whatsapp/manager';

// GET /api/accounts/[id]/chats/[chatId] - Получить сообщения конкретного чата
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; chatId: string }> }
) {
  try {
    const { id, chatId } = await params;
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');

    // Декодируем chatId (может содержать специальные символы)
    const decodedChatId = decodeURIComponent(chatId);

    const messages = await whatsappManager.getChatMessages(id, decodedChatId, limit);

    return NextResponse.json(messages);
  } catch (error: any) {
    console.error('Error getting chat messages:', error);
    return NextResponse.json(
      { error: 'Failed to get chat messages', details: error.message },
      { status: 500 }
    );
  }
}

// POST /api/accounts/[id]/chats/[chatId] - Отправить сообщение в чат
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; chatId: string }> }
) {
  try {
    const { id, chatId } = await params;
    const body = await request.json();
    const { message } = body;

    if (!message || typeof message !== 'string') {
      return NextResponse.json(
        { error: 'message is required and must be a string' },
        { status: 400 }
      );
    }

    // Декодируем chatId
    const decodedChatId = decodeURIComponent(chatId);

    // Извлекаем номер телефона из chatId (убираем @c.us)
    const to = decodedChatId.replace('@c.us', '').replace('@g.us', '');

    // Отправляем сообщение
    const result = await whatsappManager.sendMessage({
      accountId: id,
      to,
      message,
    });

    if (!result.success) {
      return NextResponse.json(
        { error: result.error },
        { status: 400 }
      );
    }

    return NextResponse.json(result);
  } catch (error: any) {
    console.error('Error sending message:', error);
    return NextResponse.json(
      { error: 'Failed to send message', details: error.message },
      { status: 500 }
    );
  }
}
