import { NextRequest, NextResponse } from 'next/server';
import { whatsappManager } from '@/lib/whatsapp/manager';

// GET /api/accounts/[id]/chats - Получить список чатов аккаунта
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const chats = await whatsappManager.getChats(id);

    return NextResponse.json(chats);
  } catch (error: any) {
    console.error('Error getting chats:', error);
    return NextResponse.json(
      { error: 'Failed to get chats', details: error.message },
      { status: 500 }
    );
  }
}
