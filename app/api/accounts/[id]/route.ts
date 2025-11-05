import { NextRequest, NextResponse } from 'next/server';
import { whatsappManager } from '@/lib/whatsapp/manager';

// GET /api/accounts/[id] - Получить информацию об аккаунте
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const account = await whatsappManager.getAccount(id);

    if (!account) {
      return NextResponse.json(
        { error: 'Account not found' },
        { status: 404 }
      );
    }

    const clientStatus = whatsappManager.getClientStatus(id);

    return NextResponse.json({
      ...account,
      clientStatus: clientStatus?.status || account.status,
      hasActiveClient: !!clientStatus,
    });
  } catch (error: any) {
    console.error('Error getting account:', error);
    return NextResponse.json(
      { error: 'Failed to get account', details: error.message },
      { status: 500 }
    );
  }
}

// DELETE /api/accounts/[id] - Удалить аккаунт
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await whatsappManager.deleteAccount(id);

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting account:', error);
    return NextResponse.json(
      { error: 'Failed to delete account', details: error.message },
      { status: 500 }
    );
  }
}
