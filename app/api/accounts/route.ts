import { NextRequest, NextResponse } from 'next/server';
import { whatsappManager } from '@/lib/whatsapp/manager';

// GET /api/accounts - Получить все аккаунты
export async function GET() {
  try {
    const accounts = await whatsappManager.getAccounts();

    // Добавляем информацию о статусе клиента из памяти
    const accountsWithClientStatus = accounts.map((account) => {
      const clientStatus = whatsappManager.getClientStatus(account.id);
      return {
        ...account,
        clientStatus: clientStatus?.status || account.status,
        hasActiveClient: !!clientStatus,
      };
    });

    return NextResponse.json(accountsWithClientStatus);
  } catch (error: any) {
    console.error('Error getting accounts:', error);
    return NextResponse.json(
      { error: 'Failed to get accounts', details: error.message },
      { status: 500 }
    );
  }
}

// POST /api/accounts - Создать новый аккаунт
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json(
        { error: 'Name is required and must be a string' },
        { status: 400 }
      );
    }

    const accountId = await whatsappManager.createAccount(name);
    const account = await whatsappManager.getAccount(accountId);

    return NextResponse.json(account, { status: 201 });
  } catch (error: any) {
    console.error('Error creating account:', error);
    return NextResponse.json(
      { error: 'Failed to create account', details: error.message },
      { status: 500 }
    );
  }
}
