import { NextRequest, NextResponse } from 'next/server';
import { whatsappManager } from '@/lib/whatsapp/manager';

// POST /api/accounts/[id]/disconnect - Отключить аккаунт
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    await whatsappManager.disconnectClient(id);

    return NextResponse.json({
      success: true,
      message: 'Client disconnected successfully'
    });
  } catch (error: any) {
    console.error('Error disconnecting account:', error);
    return NextResponse.json(
      { error: 'Failed to disconnect account', details: error.message },
      { status: 500 }
    );
  }
}
