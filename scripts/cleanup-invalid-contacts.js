const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

// Helper function to check if contactNumber is valid
function isValidPhoneNumber(number) {
  if (!number) return false;

  // Should be digits only, 7-15 characters
  const phoneRegex = /^\d{7,15}$/;
  return phoneRegex.test(number);
}

// Helper function to extract clean phone number
function extractCleanPhone(str) {
  if (!str) return null;

  // If contains @, extract part before @
  if (str.includes("@")) {
    const phone = str.split("@")[0];
    // Validate it's a valid phone number
    return isValidPhoneNumber(phone) ? phone : null;
  }

  // Otherwise validate as-is
  return isValidPhoneNumber(str) ? str : null;
}

async function cleanupInvalidContacts() {
  console.log("🔍 Starting cleanup of invalid contact numbers...");

  try {
    // Find all messages
    const allMessages = await prisma.message.findMany({
      select: {
        id: true,
        contactNumber: true,
        chatId: true,
        to: true,
        from: true,
      },
    });

    let invalidCount = 0;
    let deletedCount = 0;
    let fixedCount = 0;

    console.log(`📊 Checking ${allMessages.length} messages...`);

    for (const msg of allMessages) {
      const currentContactNumber = msg.contactNumber;

      // Try to extract clean phone from contactNumber or chatId
      let cleanPhone = extractCleanPhone(currentContactNumber) || extractCleanPhone(msg.chatId);

      if (!cleanPhone) {
        // Can't fix this - delete it
        invalidCount++;
        console.log(
          `❌ Deleting: ID=${msg.id}, contactNumber=${currentContactNumber}, chatId=${msg.chatId}`
        );

        await prisma.message.delete({
          where: { id: msg.id },
        });
        deletedCount++;
      } else if (currentContactNumber !== cleanPhone || msg.chatId.includes("@lid")) {
        // Can fix this - update the record
        console.log(
          `🔧 Fixing: ID=${msg.id}, old=${currentContactNumber}, new=${cleanPhone}`
        );

        await prisma.message.update({
          where: { id: msg.id },
          data: {
            contactNumber: cleanPhone,
            chatId: `${cleanPhone}@s.whatsapp.net`,
            to: msg.to && msg.to.includes("@") ? cleanPhone : msg.to,
            from: msg.from && msg.from.includes("@") ? cleanPhone : msg.from,
          },
        });
        fixedCount++;
      }
    }

    console.log(`\n✅ Cleanup complete!`);
    console.log(`   Total messages checked: ${allMessages.length}`);
    console.log(`   Messages fixed: ${fixedCount}`);
    console.log(`   Messages deleted: ${deletedCount}`);
    console.log(`   Valid messages kept: ${allMessages.length - deletedCount}`);
  } catch (error) {
    console.error("❌ Error during cleanup:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run cleanup
cleanupInvalidContacts().catch((error) => {
  console.error(error);
  process.exit(1);
});
