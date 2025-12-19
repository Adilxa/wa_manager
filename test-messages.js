// Правильный тест отправки сообщений с контролем скорости

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const sendTestMessage = async (accountId, to, message) => {
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

// Функция для теста с контролем скорости
const runTest = async () => {
  const accountId = "cmifthyt30000pg077z9mcsn2";
  const to = "996500660706";
  const totalMessages = 10; // НАЧНИ С 10, А НЕ 1000!

  console.log(`\n🚀 Starting test: ${totalMessages} messages`);
  console.log(`⏰ Start time: ${new Date().toLocaleTimeString()}\n`);

  let successCount = 0;
  let errorCount = 0;
  let rateLimitCount = 0;

  for (let i = 1; i <= totalMessages; i++) {
    console.log(`\n📤 Sending message ${i}/${totalMessages}...`);

    const result = await sendTestMessage(
      accountId,
      to,
      `Test message #${i} - ${new Date().toLocaleTimeString()}`
    );

    if (result.status === 200) {
      successCount++;
      console.log(`✅ Success! Daily count: ${result.data.dailyCount}/${result.data.dailyLimit}`);
      console.log(`   Message ID: ${result.data.messageId}`);
    } else if (result.status === 429) {
      rateLimitCount++;
      console.log(`⏳ Rate limited: ${result.data.error}`);

      // Если rate limit, ждем больше
      if (result.data.resetIn) {
        console.log(`   Waiting ${result.data.resetIn} seconds...`);
        await sleep(result.data.resetIn * 1000);
      } else {
        await sleep(60000); // Ждем минуту
      }

      // Повторяем попытку
      i--;
      continue;
    } else {
      errorCount++;
      console.log(`❌ Error: ${result.error || result.data?.error || 'Unknown error'}`);
    }

    // Случайная задержка между сообщениями (4-10 секунд)
    // Это ДОПОЛНИТЕЛЬНАЯ задержка к той, что уже есть на сервере
    const delay = Math.floor(Math.random() * (10000 - 4000 + 1)) + 4000;
    console.log(`   ⏱️  Waiting ${(delay/1000).toFixed(1)}s before next message...`);
    await sleep(delay);
  }

  console.log(`\n\n📊 Test Results:`);
  console.log(`   ✅ Success: ${successCount}`);
  console.log(`   ❌ Errors: ${errorCount}`);
  console.log(`   ⏳ Rate limited: ${rateLimitCount}`);
  console.log(`   ⏰ End time: ${new Date().toLocaleTimeString()}`);
  console.log(`\n✨ Test completed!\n`);
};

// Запуск теста
runTest().catch(console.error);
