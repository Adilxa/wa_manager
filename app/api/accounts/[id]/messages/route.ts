import { NextRequest, NextResponse } from 'next/server';
import { whatsappManager } from '@/lib/whatsapp/manager';

// GET /api/accounts/[id]/messages - Получить историю сообщений аккаунта
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50');

    const messages = await whatsappManager.getMessages(id, limit);

    return NextResponse.json(messages);
  } catch (error: any) {
    console.error('Error getting messages:', error);
    return NextResponse.json(
      { error: 'Failed to get messages', details: error.message },
      { status: 500 }
    );
  }
}
