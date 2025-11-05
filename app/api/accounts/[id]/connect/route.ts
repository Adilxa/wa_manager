import { NextRequest, NextResponse } from 'next/server';
import { whatsappManager } from '@/lib/whatsapp/manager';

// POST /api/accounts/[id]/connect - Подключить аккаунт (инициализировать клиент)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    await whatsappManager.initializeClient(id);

    return NextResponse.json({
      success: true,
      message: 'Client initialization started. Check status for QR code.'
    });
  } catch (error: any) {
    console.error('Error connecting account:', error);
    return NextResponse.json(
      { error: 'Failed to connect account', details: error.message },
      { status: 500 }
    );
  }
}
