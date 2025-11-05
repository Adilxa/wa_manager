import { NextRequest, NextResponse } from 'next/server';
import { whatsappManager } from '@/lib/whatsapp/manager';

// POST /api/messages/send - Отправить сообщение
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { accountId, to, message } = body;

    // Валидация
    if (!accountId || typeof accountId !== 'string') {
      return NextResponse.json(
        { error: 'accountId is required and must be a string' },
        { status: 400 }
      );
    }

    if (!to || typeof to !== 'string') {
      return NextResponse.json(
        { error: 'to is required and must be a string' },
        { status: 400 }
      );
    }

    if (!message || typeof message !== 'string') {
      return NextResponse.json(
        { error: 'message is required and must be a string' },
        { status: 400 }
      );
    }

    // Отправляем сообщение
    const result = await whatsappManager.sendMessage({
      accountId,
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
