// Тест автоматической очереди - просто кидаем сообщения, система сама обработает

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const queueMessage = async (accountId, to, message) => {
  try {
    const res = await fetch("https://ilovesanzhar.click/api/messages/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        accountId,
        message,
        to,
      }),
    });

    const data = await res.json();
    return { status: res.status, data };
  } catch (error) {
    return { status: 'error', error: error.message };
  }
};

const getQueueStatus = async (accountId) => {
  try {
    const res = await fetch(`https://ilovesanzhar.click/api/accounts/${accountId}/queue`);
    const data = await res.json();
    return data;
  } catch (error) {
    return { error: error.message };
  }
};

// Главная функция теста
const runQueueTest = async () => {
  const accountId = "cmifthyt30000pg077z9mcsn2";
  const to = "996500660706";
  const totalMessages = 100; // Можешь хоть 1000 кинуть!

  console.log(`\n🚀 Starting queue test: ${totalMessages} messages`);
  console.log(`⏰ Start time: ${new Date().toLocaleTimeString()}\n`);

  // Кидаем ВСЕ сообщения в очередь сразу
  console.log(`📥 Queueing ${totalMessages} messages...`);

  for (let i = 1; i <= totalMessages; i++) {
    const result = await queueMessage(
      accountId,
      to,
      `Test message #${i} - ${new Date().toLocaleTimeString()}`
    );

    if (result.status === 202) {
      console.log(`✅ [${i}/${totalMessages}] Queued at position ${result.data.queuePosition}`);
    } else {
      console.log(`❌ [${i}/${totalMessages}] Failed to queue: ${result.error || result.data?.error}`);
    }

    // Маленькая задержка между добавлениями в очередь (чтобы не DDOSить API)
    if (i % 10 === 0) {
      await sleep(100);
    }
  }

  console.log(`\n✅ All ${totalMessages} messages queued!`);
  console.log(`🤖 Server will process them automatically with rate limits and human behavior\n`);

  // Мониторинг очереди
  console.log(`📊 Monitoring queue status (press Ctrl+C to stop)...\n`);

  let lastQueueLength = totalMessages;
  while (lastQueueLength > 0) {
    const status = await getQueueStatus(accountId);

    if (status.error) {
      console.log(`❌ Error getting status: ${status.error}`);
      break;
    }

    const queueLength = status.queueLength;
    const dailyCount = status.limits.dailyCount;
    const dailyLimit = status.limits.dailyLimit;
    const messagesSinceRest = status.status.messagesSinceRest;
    const isResting = status.status.isResting;

    const progress = ((totalMessages - queueLength) / totalMessages * 100).toFixed(1);

    console.log(
      `📊 Queue: ${queueLength} | ` +
      `Sent: ${totalMessages - queueLength}/${totalMessages} (${progress}%) | ` +
      `Daily: ${dailyCount}/${dailyLimit} | ` +
      `Session: ${messagesSinceRest}/5 | ` +
      `${isResting ? '💤 RESTING' : '✅ ACTIVE'} | ` +
      `${new Date().toLocaleTimeString()}`
    );

    lastQueueLength = queueLength;

    // Если очередь пуста - выходим
    if (queueLength === 0) {
      console.log(`\n🎉 All messages sent successfully!`);
      break;
    }

    // Проверяем каждые 5 секунд
    await sleep(5000);
  }

  console.log(`\n⏰ End time: ${new Date().toLocaleTimeString()}`);
  console.log(`\n✨ Test completed!\n`);
};

// Запуск
runQueueTest().catch(console.error);
